import crypto from "crypto";
import bcrypt from "bcryptjs";

import Employees from "../Models/employees.js";
import ClientUser from "../Models/ClientUser.js";
import generateToken from "../utils/generateToken.js";
import sendEmail from "../utils/sendEmail.js";
import {
  passwordResetEmail,
  passwordChangedEmail,
} from "../utils/emailTemplates.js";

const RESET_TOKEN_TTL_MINUTES = 30;
// Don't send another reset email for the same account within this window
const RESET_RESEND_COOLDOWN_MS = 60 * 1000;

// The two account types differ only in these details
const REALMS = {
  admin: {
    Model: Employees,
    passwordField: "password",
    activeFilter: { status: "ACTIVE", is_deleted: false },
    resetPath: "/admin/reset-password",
    tokenPayload: (account) => ({
      userId: account._id.toString(),
      type: "admin",
    }),
  },
  client: {
    Model: ClientUser,
    passwordField: "passwordHash",
    activeFilter: { status: "ACTIVE" },
    resetPath: "/reset-password",
    tokenPayload: (account) => ({
      userId: account._id.toString(),
      clientId: account.clientId.toString(),
      type: "client",
    }),
  },
};

const hashResetToken = (token) =>
  crypto.createHash("sha256").update(token).digest("hex");

// Also served to the website through GET /api/meta, so the form and the server agree
export const MIN_PASSWORD_LENGTH = 8

// Returns an error message, or null if the password is acceptable
const validateNewPassword = (password) => {
  if (typeof password !== "string" || !password) {
    return "New password is required";
  }
  if (password.length < MIN_PASSWORD_LENGTH) {
    return `New password must be at least ${MIN_PASSWORD_LENGTH} characters`;
  }
  // bcrypt ignores everything after 72 bytes
  if (Buffer.byteLength(password, "utf8") > 72) {
    return "New password is too long";
  }
  return null;
};

// Fields that mark a password as freshly set by its owner
const passwordSetFields = async (newPassword, passwordField) => ({
  [passwordField]: await bcrypt.hash(newPassword, 12),
  mustChangePassword: false,
  passwordChangedAt: new Date(),
});

const CLEAR_RESET_TOKEN = { resetPasswordTokenHash: 1, resetPasswordExpires: 1 };

// Security notice; a failure here shouldn't undo the password change
const notifyPasswordChanged = (account) =>
  sendEmail({
    to: account.email,
    ...passwordChangedEmail({ name: account.name }),
  }).catch((error) =>
    console.error("Password changed email failed:", error.message)
  );

const changePassword = (realm) => async (req, res, next) => {
  try {
    const { Model, passwordField, tokenPayload } = realm;
    const { currentPassword, newPassword } = req.body;

    if (typeof currentPassword !== "string" || !currentPassword) {
      return res.status(400).json({
        success: false,
        message: "Current password is required",
      });
    }

    const invalid = validateNewPassword(newPassword);
    if (invalid) {
      return res.status(400).json({ success: false, message: invalid });
    }

    const account = await Model.findById(req.user.id).select(
      `+${passwordField}`
    );

    // 400 rather than 401 so the frontend doesn't treat it as a logged-out session
    if (!(await bcrypt.compare(currentPassword, account[passwordField]))) {
      return res.status(400).json({
        success: false,
        message: "Current password is incorrect",
      });
    }

    if (await bcrypt.compare(newPassword, account[passwordField])) {
      return res.status(400).json({
        success: false,
        message: "New password must be different from the current password",
      });
    }

    const updated = await Model.findByIdAndUpdate(
      account._id,
      {
        $set: await passwordSetFields(newPassword, passwordField),
        $unset: CLEAR_RESET_TOKEN,
      },
      { returnDocument: "after" }
    );

    notifyPasswordChanged(updated);

    // Older tokens stop working (see passwordChangedAt in auth middleware), so hand out a new one
    return res.status(200).json({
      success: true,
      message: "Password changed successfully",
      token: generateToken(tokenPayload(updated)),
    });
  } catch (error) {
    next(error);
  }
};

const forgotPassword = (realm) => async (req, res, next) => {
  // Same reply whether or not the account exists, so emails can't be probed
  const genericReply = {
    success: true,
    message: "If an account exists for that email, a password reset link has been sent.",
  };

  try {
    const { Model, activeFilter, resetPath } = realm;
    const { email } = req.body;

    if (typeof email !== "string" || !email.trim()) {
      return res.status(400).json({
        success: false,
        message: "Email is required",
      });
    }

    const account = await Model.findOne({
      email: email.trim().toLowerCase(),
      ...activeFilter,
    }).select("+resetPasswordExpires");

    if (!account) return res.status(200).json(genericReply);

    const ttlMs = RESET_TOKEN_TTL_MINUTES * 60 * 1000;
    const lastRequestedAt = account.resetPasswordExpires
      ? account.resetPasswordExpires.getTime() - ttlMs
      : 0;

    if (Date.now() - lastRequestedAt < RESET_RESEND_COOLDOWN_MS) {
      return res.status(200).json(genericReply);
    }

    // Only the hash is stored, so a database leak doesn't expose usable links
    const token = crypto.randomBytes(32).toString("hex");

    await Model.updateOne(
      { _id: account._id },
      {
        resetPasswordTokenHash: hashResetToken(token),
        resetPasswordExpires: new Date(Date.now() + ttlMs),
      }
    );

    const resetUrl = new URL(resetPath, process.env.FRONTEND_URL);
    resetUrl.searchParams.set("token", token);

    try {
      await sendEmail({
        to: account.email,
        ...passwordResetEmail({
          name: account.name,
          resetUrl: resetUrl.toString(),
          expiresInMinutes: RESET_TOKEN_TTL_MINUTES,
        }),
      });
    } catch (mailError) {
      // Drop the token so the cooldown doesn't block an immediate retry
      console.error("Password reset email failed:", mailError.message);
      await Model.updateOne({ _id: account._id }, { $unset: CLEAR_RESET_TOKEN });
    }

    return res.status(200).json(genericReply);
  } catch (error) {
    next(error);
  }
};

const resetPassword = (realm) => async (req, res, next) => {
  try {
    const { Model, passwordField, activeFilter } = realm;
    const { token, newPassword } = req.body;

    if (typeof token !== "string" || !token) {
      return res.status(400).json({
        success: false,
        message: "Reset token is required",
      });
    }

    const invalid = validateNewPassword(newPassword);
    if (invalid) {
      return res.status(400).json({ success: false, message: invalid });
    }

    // Find-and-update in one step so a link can't be used twice by parallel requests
    const account = await Model.findOneAndUpdate(
      {
        resetPasswordTokenHash: hashResetToken(token),
        resetPasswordExpires: { $gt: new Date() },
        ...activeFilter,
      },
      {
        $set: await passwordSetFields(newPassword, passwordField),
        $unset: CLEAR_RESET_TOKEN,
      },
      { returnDocument: "after" }
    );

    if (!account) {
      return res.status(400).json({
        success: false,
        message: "This reset link is invalid or has expired",
      });
    }

    notifyPasswordChanged(account);

    return res.status(200).json({
      success: true,
      message: "Password has been reset. Please log in with your new password.",
    });
  } catch (error) {
    next(error);
  }
};

export const adminChangePassword = changePassword(REALMS.admin);
export const adminForgotPassword = forgotPassword(REALMS.admin);
export const adminResetPassword = resetPassword(REALMS.admin);

export const clientChangePassword = changePassword(REALMS.client);
export const clientForgotPassword = forgotPassword(REALMS.client);
export const clientResetPassword = resetPassword(REALMS.client);
