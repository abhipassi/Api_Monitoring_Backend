import mongoose from "mongoose";

import Client from "../Models/clients.js";
import ClientUser from "../Models/ClientUser.js";
import Monitor from "../Models/Monitor.js";
import Incident from "../Models/Incident.js";
import CheckResult from "../Models/CheckResult.js";
import PlanRequest from "../Models/PlanRequest.js";
import AuditLog from "../Models/AuditLog.js";
import { PLAN_KEYS, getBillingCurrency, getPlanPrice, pricesAreSample } from "../../config/plans.js";

const DAY = 24 * 60 * 60 * 1000;

export const getPlatformStats = async (req, res, next) => {
  try {
    const now = Date.now();
    const [byPlanStatus, newClients, users, monitorRows, openIncidents, checks, pendingRequests] = await Promise.all([
      Client.aggregate([{ $group: { _id: { plan: "$plan", status: "$status" }, count: { $sum: 1 } } }]),
      Client.countDocuments({ createdAt: { $gte: new Date(now - 30 * DAY) } }),
      ClientUser.countDocuments({ status: "ACTIVE" }),
      Monitor.aggregate([{ $group: { _id: { status: "$status", health: "$health.status" }, count: { $sum: 1 } } }]),
      Incident.countDocuments({ status: "OPEN" }),
      CheckResult.aggregate([
        { $match: { checkedAt: { $gte: new Date(now - DAY) } } },
        { $group: { _id: null, total: { $sum: 1 }, failed: { $sum: { $cond: ["$success", 0, 1] } } } },
      ]),
      PlanRequest.countDocuments({ status: "PENDING" }),
    ]);

    const byPlan = Object.fromEntries(PLAN_KEYS.map((p) => [p, 0]));
    const byStatus = { ACTIVE: 0, SUSPENDED: 0 };
    let total = 0;
    let monthlyRevenue = 0;
    for (const row of byPlanStatus) {
      total += row.count;
      byPlan[row._id.plan] = (byPlan[row._id.plan] ?? 0) + row.count;
      byStatus[row._id.status] = (byStatus[row._id.status] ?? 0) + row.count;
      // Suspended customers aren't counted as revenue
      if (row._id.status === "ACTIVE") monthlyRevenue += getPlanPrice(row._id.plan) * row.count;
    }

    const monitors = { total: 0, active: 0, paused: 0, up: 0, down: 0, unknown: 0 };
    for (const row of monitorRows) {
      monitors.total += row.count;
      if (row._id.status === "PAUSED") monitors.paused += row.count;
      else {
        monitors.active += row.count;
        monitors[(row._id.health ?? "UNKNOWN").toLowerCase()] += row.count;
      }
    }

    return res.status(200).json({
      success: true,
      message: "Platform stats fetched",
      stats: {
        clients: { total, byPlan, byStatus, newLast30Days: newClients },
        activeUsers: users,
        monitors,
        openIncidents,
        checksLast24h: { total: checks[0]?.total ?? 0, failed: checks[0]?.failed ?? 0 },
        pendingPlanRequests: pendingRequests,
        estimatedMonthlyRevenue: {
          amount: monthlyRevenue,
          currency: getBillingCurrency(),
          isSample: pricesAreSample(),
        },
      },
    });
  } catch (error) {
    next(error);
  }
};

export const listAuditLogs = async (req, res, next) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 25));
    const filter = {};

    if (req.query.targetType) {
      if (!["CLIENT", "EMPLOYEE", "PLAN_REQUEST"].includes(req.query.targetType)) {
        return res.status(400).json({ success: false, message: "targetType is not valid" });
      }
      filter.targetType = req.query.targetType;
    }
    for (const key of ["targetId", "actorId"]) {
      if (req.query[key]) {
        if (!mongoose.isValidObjectId(req.query[key])) {
          return res.status(400).json({ success: false, message: `${key} is not valid` });
        }
        filter[key] = req.query[key];
      }
    }

    const [logs, total] = await Promise.all([
      AuditLog.find(filter).sort({ createdAt: -1, _id: -1 }).skip((page - 1) * limit).limit(limit).lean(),
      AuditLog.countDocuments(filter),
    ]);

    return res.status(200).json({
      success: true,
      message: "Audit log fetched",
      logs: logs.map((l) => ({
        id: l._id,
        actor: { id: l.actorId, name: l.actorName, email: l.actorEmail },
        action: l.action,
        targetType: l.targetType,
        targetId: l.targetId,
        targetLabel: l.targetLabel ?? null,
        changes: l.changes ?? {},
        createdAt: l.createdAt,
      })),
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    });
  } catch (error) {
    next(error);
  }
};
