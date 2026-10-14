import bcrypt from "bcryptjs";
import Employees from "../Models/employees.js";
import generatePassword from "../utils/generatePassword.js";
import sendEmail from "../utils/sendEmail.js";
import { accountCredentialsEmail } from "../utils/emailTemplates.js";

const ROLES = ["SUPER_ADMIN", "STAFF"];
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const toEmployeeResponse = (employee) => ({
    id: employee._id,
    name: employee.name,
    email: employee.email,
    phone: employee.phone,
    image_url: employee.image_url,
    role: employee.role,
    permissions: employee.permissions,
    status: employee.status,
    createdAt: employee.createdAt,
});

export const createEmployee = async (req, res, next) => {
    try {
        const {
            name,
            email,
            phone,
            role = "STAFF",
            permissions = [],
            image_url = null,
        } = req.body;

        if (
            typeof name !== "string" || !name.trim() ||
            typeof email !== "string" || !email.trim() ||
            phone === undefined || phone === null || phone === ""
        ) {
            return res.status(400).json({
                success: false,
                message: "Name, email and phone are required",
            });
        }

        const normalizedEmail = email.trim().toLowerCase();

        if (!EMAIL_REGEX.test(normalizedEmail)) {
            return res.status(400).json({
                success: false,
                message: "Invalid email address",
            });
        }

        const phoneNumber = Number(String(phone).replace(/[\s-]/g, ""));

        if (!Number.isSafeInteger(phoneNumber) || phoneNumber <= 0) {
            return res.status(400).json({
                success: false,
                message: "Phone must contain digits only",
            });
        }

        if (!ROLES.includes(role)) {
            return res.status(400).json({
                success: false,
                message: `Role must be one of ${ROLES.join(", ")}`,
            });
        }

        if (
            !Array.isArray(permissions) ||
            !permissions.every((p) => typeof p === "string" && p.trim())
        ) {
            return res.status(400).json({
                success: false,
                message: "Permissions must be an array of strings",
            });
        }

        const existing = await Employees.findOne({
            $or: [{ email: normalizedEmail }, { phone: phoneNumber }],
        });

        if (existing) {
            return res.status(409).json({
                success: false,
                message:
                    existing.email === normalizedEmail
                        ? "An employee with this email already exists"
                        : "An employee with this phone already exists",
            });
        }

        const password = generatePassword();

        const employee = await Employees.create({
            name: name.trim(),
            email: normalizedEmail,
            phone: phoneNumber,
            password: await bcrypt.hash(password, 12),
            role,
            permissions: [...new Set(permissions.map((p) => p.trim()))],
            image_url,
            mustChangePassword: true,
        });

        try {
            await sendEmail({
                to: employee.email,
                ...accountCredentialsEmail({
                    name: employee.name,
                    email: employee.email,
                    password,
                    accountLabel: "employee",
                }),
            });
        } catch (mailError) {
            // Nobody would know the password, so undo the account and let the admin retry
            console.error("Employee credentials email failed:", mailError.message);
            await Employees.deleteOne({ _id: employee._id });

            return res.status(502).json({
                success: false,
                message: "Could not send the login email, so the employee was not created. Please try again.",
            });
        }

        return res.status(201).json({
            success: true,
            message: "Employee created and login details sent to their email",
            employee: toEmployeeResponse(employee),
        });
    } catch (error) {
        // Unique index race: two requests passed the findOne check at once
        if (error.code === 11000) {
            const field = Object.keys(error.keyPattern || {})[0] || "field";
            return res.status(409).json({
                success: false,
                message: `An employee with this ${field} already exists`,
            });
        }
        next(error);
    }
};
