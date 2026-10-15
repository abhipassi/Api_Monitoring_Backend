import bcrypt from "bcryptjs";
import mongoose from "mongoose";

import Employees from "../Models/employees.js";
import { PERMISSION_KEYS } from "../../config/permissions.js";
import { diffChanges, recordAudit } from "../Services/auditService.js";
import generatePassword from "../utils/generatePassword.js";
import sendEmail from "../utils/sendEmail.js";
import { accountCredentialsEmail } from "../utils/emailTemplates.js";
import { pageParams, paginationOf, searchPattern } from "../utils/listing.js";
import { badRequest } from "../utils/respond.js";

const ROLES = ["SUPER_ADMIN", "STAFF"];
const STATUSES = ["ACTIVE", "INACTIVE"];
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

const isPermissionList = (permissions) =>
  Array.isArray(permissions) && permissions.every((p) => typeof p === "string" && PERMISSION_KEYS.includes(p.trim()));

export const createEmployee = async (req, res, next) => {
  try {
    const { name, email, phone, role = "STAFF", permissions = [], image_url = null } = req.body;

    const missing =
      typeof name !== "string" || !name.trim() ||
      typeof email !== "string" || !email.trim() ||
      phone === undefined || phone === null || phone === "";
    if (missing) return badRequest(res, "Name, email and phone are required");

    const normalizedEmail = email.trim().toLowerCase();
    if (!EMAIL_REGEX.test(normalizedEmail)) return badRequest(res, "Invalid email address");

    // Phone is stored as a number, so spaces and dashes are removed first
    const phoneNumber = Number(String(phone).replace(/[\s-]/g, ""));
    if (!Number.isSafeInteger(phoneNumber) || phoneNumber <= 0) return badRequest(res, "Phone must contain digits only");

    if (!ROLES.includes(role)) return badRequest(res, `Role must be one of ${ROLES.join(", ")}`);
    if (!isPermissionList(permissions)) {
      return badRequest(res, `Permissions must be a list of: ${PERMISSION_KEYS.join(", ")}`);
    }

    const existing = await Employees.findOne({ $or: [{ email: normalizedEmail }, { phone: phoneNumber }] });
    if (existing) {
      const field = existing.email === normalizedEmail ? "email" : "phone";
      return res.status(409).json({ success: false, message: `An employee with this ${field} already exists` });
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
        ...accountCredentialsEmail({ name: employee.name, email: employee.email, password, accountLabel: "employee" }),
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

    await recordAudit(req, {
      action: "employee.create",
      targetType: "EMPLOYEE",
      targetId: employee._id,
      targetLabel: employee.name,
      changes: { role: { from: null, to: employee.role }, email: { from: null, to: employee.email } },
    });

    return res.status(201).json({
      success: true,
      message: "Employee created and login details sent to their email",
      employee: toEmployeeResponse(employee),
    });
  } catch (error) {
    // Two requests passed the check above at the same moment and the unique index stopped the second
    if (error.code === 11000) {
      const field = Object.keys(error.keyPattern || {})[0] || "field";
      return res.status(409).json({ success: false, message: `An employee with this ${field} already exists` });
    }
    next(error);
  }
};

export const listEmployees = async (req, res, next) => {
  try {
    const { page, limit } = pageParams(req.query);
    const filter = { is_deleted: false };

    if (req.query.role) {
      if (!ROLES.includes(req.query.role)) return badRequest(res, `Role must be one of ${ROLES.join(", ")}`);
      filter.role = req.query.role;
    }
    if (req.query.status) {
      if (!STATUSES.includes(req.query.status)) return badRequest(res, `Status must be one of ${STATUSES.join(", ")}`);
      filter.status = req.query.status;
    }
    if (typeof req.query.search === "string" && req.query.search.trim()) {
      const pattern = searchPattern(req.query.search);
      filter.$or = [{ name: pattern }, { email: pattern }];
    }

    const [employees, total] = await Promise.all([
      Employees.find(filter).sort({ createdAt: -1, _id: -1 }).skip((page - 1) * limit).limit(limit),
      Employees.countDocuments(filter),
    ]);

    return res.status(200).json({
      success: true,
      message: "Employees fetched",
      employees: employees.map((e) => ({
        ...toEmployeeResponse(e),
        pendingFirstLogin: e.mustChangePassword === true,
        lastLoginAt: e.lastLoginAt ?? null,
      })),
      pagination: paginationOf(page, limit, total),
    });
  } catch (error) {
    next(error);
  }
};

export const updateEmployee = async (req, res, next) => {
  try {
    const employee = mongoose.isValidObjectId(req.params.id)
      ? await Employees.findOne({ _id: req.params.id, is_deleted: false })
      : null;
    if (!employee) return res.status(404).json({ success: false, message: "Employee not found" });

    const { name, role, status, permissions } = req.body;
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
      if (!STATUSES.includes(status)) return badRequest(res, `Status must be one of ${STATUSES.join(", ")}`);
      update.status = status;
    }
    if (permissions !== undefined) {
      if (!isPermissionList(permissions)) {
        return badRequest(res, `Permissions must be a list of: ${PERMISSION_KEYS.join(", ")}`);
      }
      update.permissions = [...new Set(permissions.map((p) => p.trim()))];
    }
    if (Object.keys(update).length === 0) return badRequest(res, "No valid fields to update");

    const isSelf = String(employee._id) === String(req.user.id);
    if (isSelf && (update.role || update.status)) return badRequest(res, "You can't change your own role or status");

    // Never leave the system without an active super admin
    const stopsBeingSuperAdmin =
      employee.role === "SUPER_ADMIN" &&
      employee.status === "ACTIVE" &&
      ((update.role && update.role !== "SUPER_ADMIN") || (update.status && update.status !== "ACTIVE"));
    if (stopsBeingSuperAdmin) {
      const others = await Employees.countDocuments({
        role: "SUPER_ADMIN",
        status: "ACTIVE",
        is_deleted: false,
        _id: { $ne: employee._id },
      });
      if (others === 0) return badRequest(res, "There must be at least one active super admin");
    }

    const before = employee.toObject();
    employee.set(update);
    await employee.save();

    await recordAudit(req, {
      action: "employee.update",
      targetType: "EMPLOYEE",
      targetId: employee._id,
      targetLabel: employee.name,
      changes: diffChanges(before, employee.toObject(), ["name", "role", "status", "permissions"]),
    });

    return res.status(200).json({
      success: true,
      message: "Employee updated",
      employee: toEmployeeResponse(employee),
    });
  } catch (error) {
    next(error);
  }
};
