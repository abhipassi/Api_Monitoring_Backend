import bcrypt from "bcryptjs";

import Client from "../Models/clients.js";
import ClientUser from "../Models/ClientUser.js";
import generateToken from "../utils/generateToken.js";
import generatePassword from "../utils/generatePassword.js";
import sendEmail from "../utils/sendEmail.js";
import { accountCredentialsEmail } from "../utils/emailTemplates.js";

export const clientRegister = async (req, res, next) => {
  try {
    const { name, email, companyName } = req.body;

    if (
      !name?.trim() ||
      !email?.trim() ||
      !companyName?.trim()
    ) {
      return res.status(400).json({
        success: false,
        message: "Name, email and company name are required",
      });
    }

    const normalizedEmail = email.trim().toLowerCase();

    const existingUser = await ClientUser.findOne({
      email: normalizedEmail,
    });

    if (existingUser) {
      return res.status(409).json({
        success: false,
        message: "An account with this email already exists",
      });
    }

    const password = generatePassword();
    const passwordHash = await bcrypt.hash(password, 12);

    let client;
    let clientUser;

    // Two inserts without a transaction (so a standalone MongoDB works): if the second fails,
    // the first is removed again
    try {
      client = await Client.create({
        name: name.trim(),
        email: normalizedEmail,
        companyName: companyName.trim(),
      });

      clientUser = await ClientUser.create({
        clientId: client._id,
        name: name.trim(),
        email: normalizedEmail,
        passwordHash,
        role: "OWNER",
        status: "ACTIVE",
        mustChangePassword: true,
      });
    } catch (createError) {
      if (client) await Client.deleteOne({ _id: client._id });

      // Two sign-ups with the same email at the same moment: the unique index lets one through
      if (createError.code === 11000) {
        return res.status(409).json({
          success: false,
          message: "An account with this email already exists",
        });
      }
      throw createError;
    }

    try {
      await sendEmail({
        to: clientUser.email,
        ...accountCredentialsEmail({
          name: clientUser.name,
          email: clientUser.email,
          password,
          accountLabel: "client",
        }),
      });
    } catch (mailError) {
      // Nobody would know the password, so undo the account and let them retry
      console.error("Client credentials email failed:", mailError.message);
      await ClientUser.deleteOne({ _id: clientUser._id });
      await Client.deleteOne({ _id: client._id });

      return res.status(502).json({
        success: false,
        message: "Could not send the login email, so the account was not created. Please try again.",
      });
    }

    // No token here: the user logs in with the password sent to their email,
    // which also proves they own that address.
    return res.status(201).json({
      success: true,
      message: "Account created. Your login details have been sent to your email.",
      user: {
        id: clientUser._id,
        name: clientUser.name,
        email: clientUser.email,
        role: clientUser.role,
      },
      client: {
        id: client._id,
        companyName: client.companyName,
        plan: client.plan,
      },
    });
  } catch (error) {
    next(error);
  }
};

export const clientLogin = async (req, res, next) => {
  try {
    const { email, password } = req.body;

    if (
      typeof email !== "string" ||
      !email.trim() ||
      typeof password !== "string" ||
      !password
    ) {
      return res.status(400).json({
        success: false,
        message: "Email and password are required",
      });
    }

    const clientUser = await ClientUser.findOne({
      email: email.trim().toLowerCase(),
      status: "ACTIVE",
    }).select("+passwordHash");

    if (
      !clientUser ||
      !(await bcrypt.compare(password, clientUser.passwordHash))
    ) {
      return res.status(401).json({
        success: false,
        message: "Invalid email or password",
      });
    }

    const client = await Client.findOne({
      _id: clientUser.clientId,
      status: "ACTIVE",
    });

    if (!client) {
      return res.status(403).json({
        success: false,
        message: "Client account is unavailable",
      });
    }

    clientUser.lastLoginAt = new Date();
    await clientUser.save();

    const token = generateToken({
      userId: clientUser._id.toString(),
      clientId: client._id.toString(),
      type: "client",
    });

    return res.status(200).json({
      success: true,
      message: "Client login successful",
      token,
      user: {
        id: clientUser._id,
        name: clientUser.name,
        email: clientUser.email,
        role: clientUser.role,
        mustChangePassword: clientUser.mustChangePassword,
      },
      client: {
        id: client._id,
        companyName: client.companyName,
        plan: client.plan,
      },
    });
  } catch (error) {
    next(error);
  }
};

export const clientMe = (req, res) => {
  const clientUser = req.user.doc;
  const client = req.client;

  return res.status(200).json({
    success: true,
    message: "Profile fetched",
    user: {
      id: clientUser._id,
      name: clientUser.name,
      email: clientUser.email,
      role: clientUser.role,
      mustChangePassword: clientUser.mustChangePassword,
    },
    client: {
      id: client._id,
      companyName: client.companyName,
      plan: client.plan,
    },
  });
};
