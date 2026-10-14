import jwt from "jsonwebtoken";

import Employees from "../Models/employees.js";
import Client from "../Models/clients.js";
import ClientUser from "../Models/ClientUser.js";

const unauthorized = (res, message = "Not authorized") =>
  res.status(401).json({ success: false, message });

// A token issued before the last password change no longer counts
const issuedBeforePasswordChange = (decoded, account) =>
  account.passwordChangedAt &&
  decoded.iat < Math.floor(account.passwordChangedAt.getTime() / 1000);

// Returns a response if the account can't use this route, otherwise null
const checkAccount = (res, decoded, account, allowPendingPasswordChange) => {
  if (issuedBeforePasswordChange(decoded, account)) {
    return unauthorized(res, "Password was changed. Please log in again");
  }

  if (account.mustChangePassword && !allowPendingPasswordChange) {
    return res.status(403).json({
      success: false,
      code: "PASSWORD_CHANGE_REQUIRED",
      message: "Please change your password to continue",
    });
  }

  return null;
};

const authenticate = (types, { allowPendingPasswordChange = false } = {}) => async (req, res, next) => {
  try {
    const header = req.headers.authorization || "";
    const [scheme, token] = header.split(" ");

    if (scheme !== "Bearer" || !token) {
      return unauthorized(res, "Authentication token missing");
    }

    let decoded;
    try {
      decoded = jwt.verify(token, process.env.JWT_SECRET);
    } catch {
      return unauthorized(res, "Invalid or expired token");
    }

    if (types.length && !types.includes(decoded.type)) {
      return res.status(403).json({
        success: false,
        message: "Access denied",
      });
    }

    if (decoded.type === "admin") {
      const employee = await Employees.findOne({
        _id: decoded.userId,
        status: "ACTIVE",
        is_deleted: false,
      });

      if (!employee) return unauthorized(res);

      const blocked = checkAccount(res, decoded, employee, allowPendingPasswordChange);
      if (blocked) return blocked;

      req.user = {
        id: employee._id,
        type: "admin",
        role: employee.role,
        permissions: employee.permissions,
        doc: employee,
      };
      return next();
    }

    if (decoded.type === "client") {
      const clientUser = await ClientUser.findOne({
        _id: decoded.userId,
        clientId: decoded.clientId,
        status: "ACTIVE",
      });

      if (!clientUser) return unauthorized(res);

      const blocked = checkAccount(res, decoded, clientUser, allowPendingPasswordChange);
      if (blocked) return blocked;

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

      req.user = {
        id: clientUser._id,
        type: "client",
        clientId: client._id,
        role: clientUser.role,
        doc: clientUser,
      };
      req.client = client;
      return next();
    }

    return unauthorized(res, "Invalid token type");
  } catch (error) {
    next(error);
  }
};

// Verifies the Bearer token and attaches the live account to req.user.
// Pass the allowed token types, e.g. protect("admin") or protect("client").
// Accounts that still have their emailed password get 403 PASSWORD_CHANGE_REQUIRED.
export const protect = (...types) => authenticate(types);

// Same as protect, but lets through accounts that still have their emailed
// password. Only for the routes they need to get out of that state (change-password, me).
export const protectAllowPasswordChange = (...types) =>
  authenticate(types, { allowPendingPasswordChange: true });

// Use after protect("admin"). SUPER_ADMIN always passes.
export const requireRole = (...roles) => (req, res, next) => {
  if (req.user?.role === "SUPER_ADMIN" || roles.includes(req.user?.role)) {
    return next();
  }

  return res.status(403).json({
    success: false,
    message: "Access denied",
  });
};
