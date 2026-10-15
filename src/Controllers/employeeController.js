import bcrypt from "bcryptjs";
import mongoose from "mongoose";
import Employees from "../Models/employees.js";
import { PERMISSION_KEYS } from "../../config/permissions.js";
import { diffChanges, recordAudit } from "../Services/auditService.js";
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
            !permissions.every((p) => typeof p === "string" && PERMISSION_KEYS.includes(p.trim()))
        ) {
            return res.status(400).json({
                success: false,
                message: `Permissions must be a list of: ${PERMISSION_KEYS.join(", ")}`,
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

const EMPLOYEE_ROLES = ["SUPER_ADMIN", "STAFF"];
const EMPLOYEE_STATUSES = ["ACTIVE", "INACTIVE"];

export const listEmployees = async (req, res, next) => {
    try {
        const page = Math.max(1, parseInt(req.query.page, 10) || 1);
        const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 20));
        const filter = { is_deleted: false };

        if (req.query.role) {
            if (!EMPLOYEE_ROLES.includes(req.query.role)) {
                return res.status(400).json({ success: false, message: `Role must be one of ${EMPLOYEE_ROLES.join(", ")}` });
            }
            filter.role = req.query.role;
        }
        if (req.query.status) {
            if (!EMPLOYEE_STATUSES.includes(req.query.status)) {
                return res.status(400).json({ success: false, message: `Status must be one of ${EMPLOYEE_STATUSES.join(", ")}` });
            }
            filter.status = req.query.status;
        }
        if (typeof req.query.search === "string" && req.query.search.trim()) {
            const pattern = new RegExp(req.query.search.trim().slice(0, 100).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
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
            pagination: { page, limit, total, pages: Math.ceil(total / limit) },
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
        const bad = (message) => res.status(400).json({ success: false, message });

        if (name !== undefined) {
            if (typeof name !== "string" || !name.trim()) return bad("Name can't be empty");
            if (name.trim().length > 100) return bad("Name must be at most 100 characters");
            update.name = name.trim();
        }
        if (role !== undefined) {
            if (!EMPLOYEE_ROLES.includes(role)) return bad(`Role must be one of ${EMPLOYEE_ROLES.join(", ")}`);
            update.role = role;
        }
        if (status !== undefined) {
            if (!EMPLOYEE_STATUSES.includes(status)) return bad(`Status must be one of ${EMPLOYEE_STATUSES.join(", ")}`);
            update.status = status;
        }
        if (permissions !== undefined) {
            if (!Array.isArray(permissions) || !permissions.every((p) => typeof p === "string" && PERMISSION_KEYS.includes(p))) {
                return bad(`Permissions must be a list of: ${PERMISSION_KEYS.join(", ")}`);
            }
            update.permissions = [...new Set(permissions)];
        }
        if (Object.keys(update).length === 0) return bad("No valid fields to update");

        const isSelf = String(employee._id) === String(req.user.id);
        if (isSelf && (update.role || update.status)) return bad("You can't change your own role or status");

        const losesSuperAdmin =
            employee.role === "SUPER_ADMIN" && employee.status === "ACTIVE" &&
            ((update.role && update.role !== "SUPER_ADMIN") || (update.status && update.status !== "ACTIVE"));
        if (losesSuperAdmin) {
            const others = await Employees.countDocuments({
                role: "SUPER_ADMIN", status: "ACTIVE", is_deleted: false, _id: { $ne: employee._id },
            });
            if (others === 0) return bad("There must be at least one active super admin");
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
