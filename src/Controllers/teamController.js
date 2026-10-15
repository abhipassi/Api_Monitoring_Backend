import bcrypt from "bcryptjs";
import mongoose from "mongoose";

import ClientUser from "../Models/ClientUser.js";
import { getPlanLimits } from "../../config/plans.js";
import generatePassword from "../utils/generatePassword.js";
import sendEmail from "../utils/sendEmail.js";
import { accountCredentialsEmail } from "../utils/emailTemplates.js";

const ROLES = ["OWNER", "MEMBER"];
const EDITABLE_STATUSES = ["ACTIVE", "DISABLED"];
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const toMemberResponse = (user) => ({
  id: user._id,
  name: user.name,
  email: user.email,
  role: user.role,
  status: user.status,
  // Still on the emailed password: has not logged in and set their own yet
  pendingFirstLogin: user.mustChangePassword === true,
  lastLoginAt: user.lastLoginAt ?? null,
  createdAt: user.createdAt,
});

const badRequest = (res, message) => res.status(400).json({ success: false, message });
const notFound = (res) => res.status(404).json({ success: false, message: "Team member not found" });

const seatLimitReached = (res, plan, limits) =>
  res.status(403).json({
    success: false,
    code: "PLAN_LIMIT_REACHED",
    message: `Your ${plan} plan allows up to ${limits.maxTeamMembers} team members. Remove someone or upgrade your plan to add more.`,
  });

// Seats are the people who can log in; disabled members don't take one
const countSeats = (clientId) => ClientUser.countDocuments({ clientId, status: "ACTIVE" });

const usageFor = (client, used) => {
  const limits = getPlanLimits(client.plan);
  return { plan: client.plan, used, max: limits.maxTeamMembers };
};

// Another client's member looks exactly like one that doesn't exist: always 404
const findMember = (req) => {
  if (!mongoose.isValidObjectId(req.params.id)) return null;
  return ClientUser.findOne({ _id: req.params.id, clientId: req.user.clientId });
};

export const listTeam = async (req, res, next) => {
  try {
    const { clientId } = req.user;
    const [members, seats] = await Promise.all([
      ClientUser.find({ clientId }).sort({ createdAt: 1, _id: 1 }),
      countSeats(clientId),
    ]);

    return res.status(200).json({
      success: true,
      message: "Team fetched",
      members: members.map(toMemberResponse),
      seats: usageFor(req.client, seats),
    });
  } catch (error) {
    next(error);
  }
};

export const addTeamMember = async (req, res, next) => {
  try {
    const { clientId } = req.user;
    const limits = getPlanLimits(req.client.plan);
    const { name, email, role = "MEMBER" } = req.body;

    if (typeof name !== "string" || !name.trim() || typeof email !== "string" || !email.trim()) {
      return badRequest(res, "Name and email are required");
    }
    if (name.trim().length > 100) return badRequest(res, "Name must be at most 100 characters");

    const normalizedEmail = email.trim().toLowerCase();
    if (!EMAIL_REGEX.test(normalizedEmail)) return badRequest(res, "Invalid email address");
    if (!ROLES.includes(role)) return badRequest(res, `Role must be one of ${ROLES.join(", ")}`);

    if ((await countSeats(clientId)) >= limits.maxTeamMembers) {
      return seatLimitReached(res, req.client.plan, limits);
    }

    // Email is unique across every client, because login finds a user by email alone
    if (await ClientUser.exists({ email: normalizedEmail })) {
      return res.status(409).json({
        success: false,
        message: "An account with this email already exists",
      });
    }

    const password = generatePassword();

    let member;
    try {
      member = await ClientUser.create({
        clientId,
        name: name.trim(),
        email: normalizedEmail,
        passwordHash: await bcrypt.hash(password, 12),
        role,
        status: "ACTIVE",
        mustChangePassword: true,
      });
    } catch (error) {
      if (error.code === 11000) {
        return res.status(409).json({ success: false, message: "An account with this email already exists" });
      }
      throw error;
    }

    // Two requests can pass the seat check together; the later one backs out
    if ((await countSeats(clientId)) > limits.maxTeamMembers) {
      await ClientUser.deleteOne({ _id: member._id });
      return seatLimitReached(res, req.client.plan, limits);
    }

    try {
      await sendEmail({
        to: member.email,
        ...accountCredentialsEmail({
          name: member.name,
          email: member.email,
          password,
          accountLabel: "team",
          invitedBy: req.user.doc.name,
        }),
      });
    } catch (mailError) {
      // Nobody would know the password, so undo and let the owner retry
      console.error("Team credentials email failed:", mailError.message);
      await ClientUser.deleteOne({ _id: member._id });
      return res.status(502).json({
        success: false,
        message: "Could not send the login email, so the team member was not added. Please try again.",
      });
    }

    return res.status(201).json({
      success: true,
      message: "Team member added and login details sent to their email",
      member: toMemberResponse(member),
    });
  } catch (error) {
    next(error);
  }
};

export const updateTeamMember = async (req, res, next) => {
  try {
    const { clientId } = req.user;
    const member = await findMember(req);
    if (!member) return notFound(res);

    const { name, role, status } = req.body;
    const update = {};

    if (name !== undefined) {
      if (typeof name !== "string" || !name.trim()) return badRequest(res, "Name can't be empty");
      if (name.trim().length > 100) return badRequest(res, "Name must be at most 100 characters");
      update.name = name.trim();
    }
    if (role !== undefined) {
      if (!ROLES.includes(role)) return badRequest(res, `Role must be one of ${ROLES.join(", ")}`);
      update.role = role;
    }
    if (status !== undefined) {
      if (!EDITABLE_STATUSES.includes(status)) return badRequest(res, `Status must be one of ${EDITABLE_STATUSES.join(", ")}`);
      update.status = status;
    }
    if (Object.keys(update).length === 0) return badRequest(res, "No valid fields to update");

    const isSelf = String(member._id) === String(req.user.id);
    if (isSelf && (update.role || update.status)) {
      return badRequest(res, "You can't change your own role or status");
    }

    const losesOwnerPower =
      member.role === "OWNER" && member.status === "ACTIVE" &&
      ((update.role && update.role !== "OWNER") || (update.status && update.status !== "ACTIVE"));
    if (losesOwnerPower) {
      const otherOwners = await ClientUser.countDocuments({
        clientId, role: "OWNER", status: "ACTIVE", _id: { $ne: member._id },
      });
      if (otherOwners === 0) return badRequest(res, "The account needs at least one active owner");
    }

    // Turning someone back on uses a seat again
    if (update.status === "ACTIVE" && member.status !== "ACTIVE") {
      const limits = getPlanLimits(req.client.plan);
      if ((await countSeats(clientId)) >= limits.maxTeamMembers) {
        return seatLimitReached(res, req.client.plan, limits);
      }
    }

    member.set(update);
    await member.save();

    return res.status(200).json({
      success: true,
      message: "Team member updated",
      member: toMemberResponse(member),
    });
  } catch (error) {
    next(error);
  }
};

export const removeTeamMember = async (req, res, next) => {
  try {
    const { clientId } = req.user;
    const member = await findMember(req);
    if (!member) return notFound(res);

    if (String(member._id) === String(req.user.id)) {
      return badRequest(res, "You can't remove yourself");
    }

    if (member.role === "OWNER" && member.status === "ACTIVE") {
      const otherOwners = await ClientUser.countDocuments({
        clientId, role: "OWNER", status: "ACTIVE", _id: { $ne: member._id },
      });
      if (otherOwners === 0) return badRequest(res, "The account needs at least one active owner");
    }

    await ClientUser.deleteOne({ _id: member._id, clientId });

    return res.status(200).json({ success: true, message: "Team member removed" });
  } catch (error) {
    next(error);
  }
};

// For someone who never received, or lost, the first email. Only works until they set their own password.
export const resendCredentials = async (req, res, next) => {
  try {
    const member = await findMember(req);
    if (!member) return notFound(res);

    if (member.status !== "ACTIVE" || !member.mustChangePassword) {
      return badRequest(res, "This person has already set their own password");
    }

    const previousHash = (await ClientUser.findById(member._id).select("+passwordHash")).passwordHash;
    const password = generatePassword();
    await ClientUser.updateOne({ _id: member._id }, { passwordHash: await bcrypt.hash(password, 12) });

    try {
      await sendEmail({
        to: member.email,
        ...accountCredentialsEmail({
          name: member.name,
          email: member.email,
          password,
          accountLabel: "team",
          invitedBy: req.user.doc.name,
        }),
      });
    } catch (mailError) {
      // Put the old password back so a failed send doesn't invalidate the email they already have
      console.error("Team credentials resend failed:", mailError.message);
      await ClientUser.updateOne({ _id: member._id }, { passwordHash: previousHash });
      return res.status(502).json({
        success: false,
        message: "Could not send the email. Please try again.",
      });
    }

    return res.status(200).json({ success: true, message: "New login details sent" });
  } catch (error) {
    next(error);
  }
};
