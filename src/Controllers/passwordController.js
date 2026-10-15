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
import { badRequest } from "../utils/respond.js";

const RESET_TOKEN_TTL_MINUTES = 30;
// Don't send another reset email for the same account within this window
const RESET_RESEND_COOLDOWN_MS = 60 * 1000;

// Staff and customers work the same way; only these details differ
const ADMIN = {
  Model: Employees,
  passwordField: "password",
  activeFilter: { status: "ACTIVE", is_deleted: false },
  resetPath: "/admin/reset-password",
  tokenFor: (account) => generateToken({ userId: account._id.toString(), type: "admin" }),
};

const CLIENT = {
  Model: ClientUser,
  passwordField: "passwordHash",
  activeFilter: { status: "ACTIVE" },
  resetPath: "/reset-password",
  tokenFor: (account) =>
    generateToken({
      userId: account._id.toString(),
      clientId: account.clientId.toString(),
      type: "client",
    }),
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

// The fields to save when someone sets a new password
const newPasswordFields = async (account, newPassword) => ({
  [account.passwordField]: await bcrypt.hash(newPassword, 12),
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

const changePassword = (account) => async (req, res, next) => {
  try {
    const { currentPassword, newPassword } = req.body;

    if (typeof currentPassword !== "string" || !currentPassword) {
      return badRequest(res, "Current password is required");
    }
    const problem = validateNewPassword(newPassword);
    if (problem) return badRequest(res, problem);

    const user = await account.Model.findById(req.user.id).select(`+${account.passwordField}`);
    const savedHash = user[account.passwordField];

    // 400 rather than 401 so the frontend doesn't treat it as a logged-out session
    if (!(await bcrypt.compare(currentPassword, savedHash))) {
      return badRequest(res, "Current password is incorrect");
    }
    if (await bcrypt.compare(newPassword, savedHash)) {
      return badRequest(res, "New password must be different from the current password");
    }

    const updated = await account.Model.findByIdAndUpdate(
      user._id,
      { $set: await newPasswordFields(account, newPassword), $unset: CLEAR_RESET_TOKEN },
      { returnDocument: "after" }
    );

    notifyPasswordChanged(updated);

    // Older tokens stop working (see passwordChangedAt in auth middleware), so hand out a new one
    return res.status(200).json({
      success: true,
      message: "Password changed successfully",
      token: account.tokenFor(updated),
    });
  } catch (error) {
    next(error);
  }
};

const forgotPassword = (account) => async (req, res, next) => {
  // Same reply whether or not the account exists, so emails can't be probed
  const sameReply = () =>
    res.status(200).json({
      success: true,
      message: "If an account exists for that email, a password reset link has been sent.",
    });

  try {
    const { email } = req.body;
    if (typeof email !== "string" || !email.trim()) return badRequest(res, "Email is required");

    const user = await account.Model.findOne({
      email: email.trim().toLowerCase(),
      ...account.activeFilter,
    }).select("+resetPasswordExpires");
    if (!user) return sameReply();

    // The expiry time tells us when the last link was requested
    const ttlMs = RESET_TOKEN_TTL_MINUTES * 60 * 1000;
    const lastRequestedAt = user.resetPasswordExpires ? user.resetPasswordExpires.getTime() - ttlMs : 0;
    if (Date.now() - lastRequestedAt < RESET_RESEND_COOLDOWN_MS) return sameReply();

    // Only the hash is stored, so a database leak doesn't expose usable links
    const token = crypto.randomBytes(32).toString("hex");
    await account.Model.updateOne(
      { _id: user._id },
      { resetPasswordTokenHash: hashResetToken(token), resetPasswordExpires: new Date(Date.now() + ttlMs) }
    );

    const resetUrl = new URL(account.resetPath, process.env.FRONTEND_URL);
    resetUrl.searchParams.set("token", token);

    try {
      await sendEmail({
        to: user.email,
        ...passwordResetEmail({
          name: user.name,
          resetUrl: resetUrl.toString(),
          expiresInMinutes: RESET_TOKEN_TTL_MINUTES,
        }),
      });
    } catch (mailError) {
      // Drop the token so the cooldown doesn't block an immediate retry
      console.error("Password reset email failed:", mailError.message);
      await account.Model.updateOne({ _id: user._id }, { $unset: CLEAR_RESET_TOKEN });
    }

    return sameReply();
  } catch (error) {
    next(error);
  }
};

const resetPassword = (account) => async (req, res, next) => {
  try {
    const { token, newPassword } = req.body;

    if (typeof token !== "string" || !token) return badRequest(res, "Reset token is required");
    const problem = validateNewPassword(newPassword);
    if (problem) return badRequest(res, problem);

    // Find-and-update in one step so a link can't be used twice by parallel requests
    const user = await account.Model.findOneAndUpdate(
      {
        resetPasswordTokenHash: hashResetToken(token),
        resetPasswordExpires: { $gt: new Date() },
        ...account.activeFilter,
      },
      { $set: await newPasswordFields(account, newPassword), $unset: CLEAR_RESET_TOKEN },
      { returnDocument: "after" }
    );
    if (!user) return badRequest(res, "This reset link is invalid or has expired");

    notifyPasswordChanged(user);

    return res.status(200).json({
      success: true,
      message: "Password has been reset. Please log in with your new password.",
    });
  } catch (error) {
    next(error);
  }
};

export const adminChangePassword = changePassword(ADMIN);
export const adminForgotPassword = forgotPassword(ADMIN);
export const adminResetPassword = resetPassword(ADMIN);

export const clientChangePassword = changePassword(CLIENT);
export const clientForgotPassword = forgotPassword(CLIENT);
export const clientResetPassword = resetPassword(CLIENT);
