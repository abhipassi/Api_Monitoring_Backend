// Creates the first SUPER_ADMIN so there is someone who can log in and add employees.
//
//   npm run seed:admin -- --email you@company.com --name "Your Name" --phone 9876543210
//
// Each value can also come from SEED_ADMIN_EMAIL / SEED_ADMIN_NAME / SEED_ADMIN_PHONE.
// A random password is generated and emailed, exactly like createEmployee. If email
// isn't set up yet, add --print-password to show it in the terminal instead.
import "dotenv/config";
import bcrypt from "bcryptjs";
import mongoose from "mongoose";

import connectDB from "../config/db.js";
import Employees from "../src/Models/employees.js";
import generatePassword from "../src/utils/generatePassword.js";
import sendEmail from "../src/utils/sendEmail.js";
import { accountCredentialsEmail } from "../src/utils/emailTemplates.js";

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const parseArgs = (argv) => {
    const args = { printPassword: false };
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === "--print-password") args.printPassword = true;
        else if (["--email", "--name", "--phone"].includes(arg)) {
            args[arg.slice(2)] = argv[++i];
        } else {
            throw new Error(`Unknown argument: ${arg}`);
        }
    }
    return args;
};

const fail = (message) => {
    console.error(`\n${message}\n`);
    process.exitCode = 1;
};

const main = async () => {
    const args = parseArgs(process.argv.slice(2));

    const name = (args.name || process.env.SEED_ADMIN_NAME || "").trim();
    const email = (args.email || process.env.SEED_ADMIN_EMAIL || "").trim().toLowerCase();
    const phoneRaw = String(args.phone || process.env.SEED_ADMIN_PHONE || "").replace(/[\s-]/g, "");
    const phone = Number(phoneRaw);

    if (!name || !email || !phoneRaw) {
        return fail(
            "Name, email and phone are required.\n" +
            'Usage: npm run seed:admin -- --email you@company.com --name "Your Name" --phone 9876543210'
        );
    }
    if (!EMAIL_REGEX.test(email)) return fail("Invalid email address.");
    if (!Number.isSafeInteger(phone) || phone <= 0) return fail("Phone must contain digits only.");

    await connectDB();

    const existingAdmin = await Employees.findOne({ role: "SUPER_ADMIN", is_deleted: false });
    if (existingAdmin) {
        return fail(
            `A super admin already exists (${existingAdmin.email}). Nothing was changed.\n` +
            "Use that account to add more employees, or reset its password with \"Forgot password\"."
        );
    }

    const clash = await Employees.findOne({ $or: [{ email }, { phone }] });
    if (clash) {
        return fail(`An employee with this ${clash.email === email ? "email" : "phone"} already exists. Nothing was changed.`);
    }

    const password = generatePassword();
    console.log(password,'this is the password')
    const admin = await Employees.create({
        name,
        email,
        phone,
        password: await bcrypt.hash(password, 12),
        role: "SUPER_ADMIN",
        mustChangePassword: true,
    });

    if (args.printPassword) {
        console.log(`\nSuper admin created: ${admin.email}`);
        console.log(`Temporary password:  ${password}`);
        console.log("It must be changed at first login. This is the only time it is shown.\n");
        return;
    }

    try {
        await sendEmail({
            to: admin.email,
            ...accountCredentialsEmail({
                name: admin.name,
                email: admin.email,
                password,
                accountLabel: "super admin",
            }),
        });
    } catch (mailError) {
        await Employees.deleteOne({ _id: admin._id });
        return fail(
            `Could not send the login email (${mailError.message}), so nothing was created.\n` +
            "Check the SMTP_* values in .env, or run again with --print-password."
        );
    }

    console.log(`\nSuper admin created: ${admin.email}`);
    console.log("The login details were sent to that address.\n");
};

try {
    await main();
} catch (error) {
    fail(error.message);
} finally {
    await mongoose.disconnect();
}
