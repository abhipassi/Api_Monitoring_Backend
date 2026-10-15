import mongoose from "mongoose";

import Client from "../Models/clients.js";
import ClientUser from "../Models/ClientUser.js";
import Monitor from "../Models/Monitor.js";
import Incident from "../Models/Incident.js";
import PlanRequest from "../Models/PlanRequest.js";
import { PLAN_KEYS } from "../../config/plans.js";
import { getUsage, planChangeWarnings, planName } from "../Services/planService.js";
import { diffChanges, recordAudit } from "../Services/auditService.js";
import { resyncClientSchedules } from "../Services/monitorQueue.js";
import sendEmail from "../utils/sendEmail.js";
import { planChangedEmail } from "../utils/emailTemplates.js";

export const CLIENT_STATUSES = ["ACTIVE", "SUSPENDED"];

const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const badRequest = (res, message) => res.status(400).json({ success: false, message });
const notFound = (res) => res.status(404).json({ success: false, message: "Customer not found" });

const toClientResponse = (client) => ({
  id: client._id,
  name: client.name,
  companyName: client.companyName ?? null,
  email: client.email,
  plan: client.plan,
  status: client.status,
  subscription: {
    provider: client.subscription?.provider ?? "none",
    status: client.subscription?.status ?? "NONE",
    currentPeriodEnd: client.subscription?.currentPeriodEnd ?? null,
    cancelAtPeriodEnd: client.subscription?.cancelAtPeriodEnd ?? false,
  },
  createdAt: client.createdAt,
});

const countsBy = async (Model, field, ids, match = {}) => {
  const rows = await Model.aggregate([
    { $match: { clientId: { $in: ids }, ...match } },
    { $group: { _id: `$${field}`, count: { $sum: 1 } } },
  ]);
  return new Map(rows.map((r) => [String(r._id), r.count]));
};

export const listClients = async (req, res, next) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 20));
    const filter = {};

    if (req.query.plan) {
      if (!PLAN_KEYS.includes(req.query.plan)) return badRequest(res, `Plan must be one of ${PLAN_KEYS.join(", ")}`);
      filter.plan = req.query.plan;
    }
    if (req.query.status) {
      if (!CLIENT_STATUSES.includes(req.query.status)) return badRequest(res, `Status must be one of ${CLIENT_STATUSES.join(", ")}`);
      filter.status = req.query.status;
    }
    if (typeof req.query.search === "string" && req.query.search.trim()) {
      const pattern = new RegExp(escapeRegex(req.query.search.trim().slice(0, 100)), "i");
      filter.$or = [{ name: pattern }, { companyName: pattern }, { email: pattern }];
    }

    const [clients, total] = await Promise.all([
      Client.find(filter).sort({ createdAt: -1, _id: -1 }).skip((page - 1) * limit).limit(limit).lean(),
      Client.countDocuments(filter),
    ]);

    const ids = clients.map((c) => c._id);
    const [monitorCounts, userCounts, pending] = await Promise.all([
      countsBy(Monitor, "clientId", ids),
      countsBy(ClientUser, "clientId", ids, { status: "ACTIVE" }),
      PlanRequest.find({ clientId: { $in: ids }, status: "PENDING" }).select("clientId").lean(),
    ]);
    const pendingIds = new Set(pending.map((p) => String(p.clientId)));

    return res.status(200).json({
      success: true,
      message: "Customers fetched",
      clients: clients.map((c) => ({
        ...toClientResponse(c),
        monitorCount: monitorCounts.get(String(c._id)) ?? 0,
        activeUserCount: userCounts.get(String(c._id)) ?? 0,
        hasPendingPlanRequest: pendingIds.has(String(c._id)),
      })),
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    });
  } catch (error) {
    next(error);
  }
};

export const getClient = async (req, res, next) => {
  try {
    const client = mongoose.isValidObjectId(req.params.id) ? await Client.findById(req.params.id) : null;
    if (!client) return notFound(res);

    const [users, usage, openIncidents, health, pending] = await Promise.all([
      ClientUser.find({ clientId: client._id }).sort({ createdAt: 1, _id: 1 }).lean(),
      getUsage(client._id, client.plan),
      Incident.countDocuments({ clientId: client._id, status: "OPEN" }),
      Monitor.aggregate([
        { $match: { clientId: client._id } },
        { $group: { _id: { status: "$status", health: "$health.status" }, count: { $sum: 1 } } },
      ]),
      PlanRequest.findOne({ clientId: client._id, status: "PENDING" }).lean(),
    ]);

    const monitors = { total: 0, paused: 0, up: 0, down: 0, unknown: 0 };
    for (const row of health) {
      monitors.total += row.count;
      if (row._id.status === "PAUSED") monitors.paused += row.count;
      else monitors[(row._id.health ?? "UNKNOWN").toLowerCase()] += row.count;
    }

    return res.status(200).json({
      success: true,
      message: "Customer fetched",
      client: toClientResponse(client),
      users: users.map((u) => ({
        id: u._id,
        name: u.name,
        email: u.email,
        role: u.role,
        status: u.status,
        pendingFirstLogin: u.mustChangePassword === true,
        lastLoginAt: u.lastLoginAt ?? null,
      })),
      usage,
      monitors,
      openIncidents,
      pendingPlanRequest: pending
        ? { id: pending._id, fromPlan: pending.fromPlan, toPlan: pending.toPlan, createdAt: pending.createdAt }
        : null,
    });
  } catch (error) {
    next(error);
  }
};

export const updateClient = async (req, res, next) => {
  try {
    const client = mongoose.isValidObjectId(req.params.id) ? await Client.findById(req.params.id) : null;
    if (!client) return notFound(res);

    const { plan, status, companyName } = req.body;
    const update = {};

    if (plan !== undefined) {
      if (!PLAN_KEYS.includes(plan)) return badRequest(res, `Plan must be one of ${PLAN_KEYS.join(", ")}`);
      update.plan = plan;
    }
    if (status !== undefined) {
      if (!CLIENT_STATUSES.includes(status)) return badRequest(res, `Status must be one of ${CLIENT_STATUSES.join(", ")}`);
      update.status = status;
    }
    if (companyName !== undefined) {
      if (typeof companyName !== "string" || !companyName.trim()) return badRequest(res, "Company name can't be empty");
      if (companyName.trim().length > 100) return badRequest(res, "Company name must be at most 100 characters");
      update.companyName = companyName.trim();
    }

    const before = client.toObject();
    const changed = Object.fromEntries(Object.entries(update).filter(([k, v]) => before[k] !== v));
    if (Object.keys(changed).length === 0) return badRequest(res, "Nothing to change");

    client.set(changed);
    await client.save();

    await recordAudit(req, {
      action: "client.update",
      targetType: "CLIENT",
      targetId: client._id,
      targetLabel: client.companyName || client.name,
      changes: diffChanges(before, client.toObject(), ["plan", "status", "companyName"]),
    });

    // Plan or status decides how often (or whether) monitors run, so apply it now
    if (changed.plan || changed.status) await resyncClientSchedules(client._id);

    if (changed.plan) {
      const owners = await ClientUser.find({ clientId: client._id, role: "OWNER", status: "ACTIVE" }).select("name email").lean();
      await Promise.allSettled(
        owners.map((owner) =>
          sendEmail({
            to: owner.email,
            ...planChangedEmail({
              name: owner.name,
              clientName: client.companyName || client.name,
              fromPlanName: planName(before.plan),
              toPlanName: planName(client.plan),
            }),
          })
        )
      ).then((outcomes) =>
        outcomes.forEach((o) => o.status === "rejected" && console.error("Plan change email failed:", o.reason?.message))
      );
    }

    return res.status(200).json({
      success: true,
      message: "Customer updated",
      client: toClientResponse(client),
      warnings: changed.plan ? await planChangeWarnings(client._id, client.plan) : [],
    });
  } catch (error) {
    next(error);
  }
};
