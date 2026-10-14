import mongoose from "mongoose";

import Monitor from "../Models/Monitor.js";
import CheckResult from "../Models/CheckResult.js";
import { removeMonitorSchedule, syncMonitorSchedule } from "../Services/monitorQueue.js";
import { closeOpenIncident, deleteIncidentsForMonitor } from "../Services/incidentService.js";
import { getPlanLimits } from "../../config/plans.js";
import { validateMonitorInput } from "../utils/validateMonitorInput.js";

const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const toMonitorResponse = (monitor) => ({
  id: monitor._id,
  name: monitor.name,
  url: monitor.url,
  method: monitor.method,
  headers: monitor.headers,
  body: monitor.body,
  expectedStatus: monitor.expectedStatus,
  intervalSeconds: monitor.intervalSeconds,
  timeoutSeconds: monitor.timeoutSeconds,
  status: monitor.status,
  health: {
    status: monitor.health?.status ?? "UNKNOWN",
    lastCheckedAt: monitor.health?.lastCheckedAt ?? null,
    lastStatusCode: monitor.health?.lastStatusCode ?? null,
    lastResponseTimeMs: monitor.health?.lastResponseTimeMs ?? null,
    lastError: monitor.health?.lastErrorType
      ? { type: monitor.health.lastErrorType, message: monitor.health.lastErrorMessage }
      : null,
    consecutiveFailures: monitor.health?.consecutiveFailures ?? 0,
  },
  createdAt: monitor.createdAt,
  updatedAt: monitor.updatedAt,
});

const toUsage = (client, used) => {
  const limits = getPlanLimits(client.plan);
  return {
    plan: client.plan,
    used,
    maxMonitors: limits.maxMonitors,
    minIntervalSeconds: limits.minIntervalSeconds,
    maxTimeoutSeconds: limits.maxTimeoutSeconds,
  };
};

const badRequest = (res, errors) =>
  res.status(400).json({ success: false, message: errors[0], errors });

const planLimitReached = (res, client, limits) =>
  res.status(403).json({
    success: false,
    code: "PLAN_LIMIT_REACHED",
    message: `Your ${client.plan} plan allows up to ${limits.maxMonitors} monitors. Delete one or upgrade your plan to add more.`,
  });

const notFound = (res) =>
  res.status(404).json({ success: false, message: "Monitor not found" });

// Another tenant's monitor looks exactly like one that doesn't exist: always 404
const findOwned = (req) => {
  if (!mongoose.isValidObjectId(req.params.id)) return null;
  return Monitor.findOne({ _id: req.params.id, clientId: req.user.clientId });
};

export const createMonitor = async (req, res, next) => {
  try {
    const limits = getPlanLimits(req.client.plan);
    const { clientId } = req.user;

    const result = validateMonitorInput(req.body, { plan: limits });
    if (result.errors) return badRequest(res, result.errors);

    if ((await Monitor.countDocuments({ clientId })) >= limits.maxMonitors) {
      return planLimitReached(res, req.client, limits);
    }

    // Only validated fields are copied, so clientId/createdBy can't be set from the request
    const monitor = await Monitor.create({
      ...result.data,
      clientId,
      createdBy: req.user.id,
    });

    // Two requests can pass the count check together; the later one backs out
    if ((await Monitor.countDocuments({ clientId })) > limits.maxMonitors) {
      await Monitor.deleteOne({ _id: monitor._id });
      return planLimitReached(res, req.client, limits);
    }

    // Starts the repeating check (the first one runs straight away). If Redis is down the
    // monitor still exists and the worker's reconcile pass schedules it later.
    await syncMonitorSchedule(monitor, req.client.plan);

    return res.status(201).json({
      success: true,
      message: "Monitor created",
      monitor: toMonitorResponse(monitor),
    });
  } catch (error) {
    next(error);
  }
};

export const listMonitors = async (req, res, next) => {
  try {
    const { clientId } = req.user;

    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 20));

    const filter = { clientId };

    if (typeof req.query.status === "string" && req.query.status) {
      const status = req.query.status.toUpperCase();
      if (!["ACTIVE", "PAUSED"].includes(status)) {
        return badRequest(res, ["Status filter must be ACTIVE or PAUSED"]);
      }
      filter.status = status;
    }

    if (typeof req.query.search === "string" && req.query.search.trim()) {
      const pattern = new RegExp(escapeRegex(req.query.search.trim().slice(0, 100)), "i");
      filter.$or = [{ name: pattern }, { url: pattern }];
    }

    const [monitors, total, used] = await Promise.all([
      Monitor.find(filter)
        .sort({ createdAt: -1, _id: -1 })
        .skip((page - 1) * limit)
        .limit(limit),
      Monitor.countDocuments(filter),
      Monitor.countDocuments({ clientId }),
    ]);

    return res.status(200).json({
      success: true,
      message: "Monitors fetched",
      monitors: monitors.map(toMonitorResponse),
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
      usage: toUsage(req.client, used),
    });
  } catch (error) {
    next(error);
  }
};

export const getMonitor = async (req, res, next) => {
  try {
    const monitor = await findOwned(req);
    if (!monitor) return notFound(res);

    return res.status(200).json({
      success: true,
      message: "Monitor fetched",
      monitor: toMonitorResponse(monitor),
    });
  } catch (error) {
    next(error);
  }
};

export const updateMonitor = async (req, res, next) => {
  try {
    const monitor = await findOwned(req);
    if (!monitor) return notFound(res);

    const result = validateMonitorInput(req.body, {
      plan: getPlanLimits(req.client.plan),
      existing: monitor,
    });
    if (result.errors) return badRequest(res, result.errors);

    if (Object.keys(result.data).length === 0) {
      return badRequest(res, ["No valid fields to update"]);
    }

    const previousStatus = monitor.status;
    monitor.set(result.data);

    // Resuming starts a fresh streak; otherwise stale failures from before the pause would
    // count towards a new incident on the very first failed check
    if (previousStatus === "PAUSED" && monitor.status === "ACTIVE") {
      monitor.set("health.status", "UNKNOWN");
      monitor.set("health.consecutiveFailures", 0);
    }

    await monitor.save();

    // A paused monitor can't recover, so close its open incident rather than leave it open forever
    if (previousStatus === "ACTIVE" && monitor.status === "PAUSED") {
      await closeOpenIncident(monitor._id, "PAUSED");
    }

    // Only a change to the interval or to pause/resume affects the timetable; other edits
    // are picked up by the next check because the worker reads the monitor fresh each time
    if ("status" in result.data || "intervalSeconds" in result.data) {
      await syncMonitorSchedule(monitor, req.client.plan);
    }

    return res.status(200).json({
      success: true,
      message: "Monitor updated",
      monitor: toMonitorResponse(monitor),
    });
  } catch (error) {
    next(error);
  }
};

export const deleteMonitor = async (req, res, next) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return notFound(res);

    const monitor = await Monitor.findOneAndDelete({
      _id: req.params.id,
      clientId: req.user.clientId,
    });
    if (!monitor) return notFound(res);

    await removeMonitorSchedule(monitor._id);
    await CheckResult.deleteMany({ monitorId: monitor._id, clientId: req.user.clientId });
    await deleteIncidentsForMonitor(monitor._id, req.user.clientId);

    return res.status(200).json({
      success: true,
      message: "Monitor deleted",
    });
  } catch (error) {
    next(error);
  }
};

export const listMonitorResults = async (req, res, next) => {
  try {
    const monitor = await findOwned(req);
    if (!monitor) return notFound(res);

    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 50));
    const filter = { monitorId: monitor._id, clientId: req.user.clientId };

    // `before` is the checkedAt of the last result already received, for paging back in time
    if (typeof req.query.before === "string" && req.query.before) {
      const before = new Date(req.query.before);
      if (Number.isNaN(before.getTime())) {
        return badRequest(res, ["`before` must be a valid date"]);
      }
      filter.checkedAt = { $lt: before };
    }

    const results = await CheckResult.find(filter).sort({ checkedAt: -1 }).limit(limit);

    return res.status(200).json({
      success: true,
      message: "Results fetched",
      results: results.map((r) => ({
        id: r._id,
        checkedAt: r.checkedAt,
        success: r.success,
        statusCode: r.statusCode,
        responseTimeMs: r.responseTimeMs,
        error: r.error?.type ? { type: r.error.type, message: r.error.message } : null,
      })),
    });
  } catch (error) {
    next(error);
  }
};
