import mongoose from "mongoose";

import Monitor from "../Models/Monitor.js";
import CheckResult from "../Models/CheckResult.js";
import Incident from "../Models/Incident.js";
import { badRequest } from "../utils/respond.js";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

// Each range also decides how coarse the chart is, so every chart stays about 100-170 points
const RANGES = {
  "24h": { ms: DAY, bucketMs: 15 * 60 * 1000 },
  "7d": { ms: 7 * DAY, bucketMs: HOUR },
  "30d": { ms: 30 * DAY, bucketMs: 6 * HOUR },
};

const parseRange = (req) => {
  const key = typeof req.query.range === "string" && req.query.range ? req.query.range : "24h";
  const range = RANGES[key];
  if (!range) return { error: `Range must be one of ${Object.keys(RANGES).join(", ")}` };
  const to = new Date();
  return { key, ...range, from: new Date(to.getTime() - range.ms), to };
};

// Uptime is successful checks / all checks. It never shows 100% if anything failed:
// 1 failure in 20,000 checks is 99.995%, which would round to a misleading 100.
const uptimePercent = (total, failed) => {
  if (total === 0) return null;
  if (failed === 0) return 100;
  const raw = ((total - failed) / total) * 100;
  return Math.min(99.99, Math.floor(raw * 100) / 100);
};

const round = (n) => (n === null || n === undefined ? null : Math.round(n));

// Response times describe successful checks only: a failed check's "time" is how long it took to
// fail (often the timeout), which would make a healthy API look slow whenever it had an outage.
const responseTimeSummary = (g) =>
  g.successful === 0
    ? null
    : {
        avg: round(g.avg),
        min: round(g.min),
        max: round(g.max),
        p50: round(g.percentiles?.[0]),
        p95: round(g.percentiles?.[1]),
        p99: round(g.percentiles?.[2]),
      };

// Shared by the single-monitor and overview endpoints
const summaryGroup = (id) => ({
  _id: id,
  total: { $sum: 1 },
  successful: { $sum: { $cond: ["$success", 1, 0] } },
  avg: { $avg: { $cond: ["$success", "$responseTimeMs", null] } },
  min: { $min: { $cond: ["$success", "$responseTimeMs", null] } },
  max: { $max: { $cond: ["$success", "$responseTimeMs", null] } },
  percentiles: {
    $percentile: {
      input: { $cond: ["$success", "$responseTimeMs", null] },
      p: [0.5, 0.95, 0.99],
      method: "approximate",
    },
  },
  firstCheckAt: { $min: "$checkedAt" },
  lastCheckAt: { $max: "$checkedAt" },
});

const findOwnedMonitor = (req) => {
  if (!mongoose.isValidObjectId(req.params.id)) return null;
  return Monitor.findOne({ _id: req.params.id, clientId: req.user.clientId }).select("_id name");
};

const notFound = (res) => res.status(404).json({ success: false, message: "Monitor not found" });

export const getMonitorStats = async (req, res, next) => {
  try {
    const range = parseRange(req);
    if (range.error) return badRequest(res, range.error);

    const monitor = await findOwnedMonitor(req);
    if (!monitor) return notFound(res);

    const match = {
      monitorId: monitor._id,
      clientId: req.user.clientId,
      checkedAt: { $gte: range.from, $lte: range.to },
    };

    const [facets] = await CheckResult.aggregate([
      { $match: match },
      {
        $facet: {
          summary: [{ $group: summaryGroup(null) }],
          errors: [
            { $match: { success: false } },
            { $group: { _id: { $ifNull: ["$error.type", "UNKNOWN"] }, count: { $sum: 1 } } },
            { $sort: { count: -1 } },
          ],
        },
      },
    ]);

    const g = facets.summary[0] ?? { total: 0, successful: 0 };
    const failed = g.total - g.successful;

    // Incidents that overlap the range, with downtime clipped to the range
    const incidents = await Incident.find({
      monitorId: monitor._id,
      clientId: req.user.clientId,
      startedAt: { $lt: range.to },
      $or: [{ resolvedAt: null }, { resolvedAt: { $gt: range.from } }],
    })
      .select("startedAt resolvedAt status")
      .lean();

    const downtimeMs = incidents.reduce((sum, i) => {
      const start = Math.max(i.startedAt.getTime(), range.from.getTime());
      const end = Math.min((i.resolvedAt ?? range.to).getTime(), range.to.getTime());
      return sum + Math.max(0, end - start);
    }, 0);

    return res.status(200).json({
      success: true,
      message: "Stats fetched",
      stats: {
        range: range.key,
        from: range.from,
        to: range.to,
        checks: { total: g.total, successful: g.successful, failed },
        uptimePercent: uptimePercent(g.total, failed),
        responseTimeMs: g.total ? responseTimeSummary(g) : null,
        errors: facets.errors.map((e) => ({ type: e._id, count: e.count })),
        incidents: {
          count: incidents.length,
          open: incidents.some((i) => i.status === "OPEN"),
          downtimeSeconds: Math.round(downtimeMs / 1000),
        },
        // Lets the UI say "based on 3 hours of data" for a monitor younger than the range
        firstCheckAt: g.firstCheckAt ?? null,
        lastCheckAt: g.lastCheckAt ?? null,
      },
    });
  } catch (error) {
    next(error);
  }
};

export const getMonitorChart = async (req, res, next) => {
  try {
    const range = parseRange(req);
    if (range.error) return badRequest(res, range.error);

    const monitor = await findOwnedMonitor(req);
    if (!monitor) return notFound(res);

    // Buckets sit on a fixed grid (multiples of the bucket size since 1970), so a point keeps
    // its meaning between requests instead of drifting with the time of the call
    const { bucketMs } = range;
    const firstBucket = Math.floor(range.from.getTime() / bucketMs) * bucketMs;

    const rows = await CheckResult.aggregate([
      {
        $match: {
          monitorId: monitor._id,
          clientId: req.user.clientId,
          checkedAt: { $gte: new Date(firstBucket), $lte: range.to },
        },
      },
      {
        $group: {
          _id: {
            $subtract: [{ $toLong: "$checkedAt" }, { $mod: [{ $toLong: "$checkedAt" }, bucketMs] }],
          },
          checks: { $sum: 1 },
          failures: { $sum: { $cond: ["$success", 0, 1] } },
          avg: { $avg: { $cond: ["$success", "$responseTimeMs", null] } },
          max: { $max: { $cond: ["$success", "$responseTimeMs", null] } },
        },
      },
    ]);

    const byBucket = new Map(rows.map((r) => [r._id, r]));
    const points = [];
    for (let t = firstBucket; t <= range.to.getTime(); t += bucketMs) {
      const r = byBucket.get(t);
      points.push({
        t: new Date(t),
        checks: r?.checks ?? 0,
        failures: r?.failures ?? 0,
        // null (not 0) when nothing ran, so a chart shows a gap rather than a fake outage
        uptimePercent: r ? uptimePercent(r.checks, r.failures) : null,
        avgResponseTimeMs: round(r?.avg),
        maxResponseTimeMs: round(r?.max),
      });
    }

    return res.status(200).json({
      success: true,
      message: "Chart data fetched",
      chart: {
        range: range.key,
        from: new Date(firstBucket),
        to: range.to,
        bucketSeconds: bucketMs / 1000,
        points,
      },
    });
  } catch (error) {
    next(error);
  }
};

export const getOverview = async (req, res, next) => {
  try {
    const range = parseRange(req);
    if (range.error) return badRequest(res, range.error);

    const { clientId } = req.user;

    const [monitors, perMonitorRows, openIncidents] = await Promise.all([
      Monitor.find({ clientId }).select("name status health.status").sort({ name: 1, _id: 1 }).lean(),
      CheckResult.aggregate([
        { $match: { clientId, checkedAt: { $gte: range.from, $lte: range.to } } },
        { $group: summaryGroup("$monitorId") },
      ]),
      Incident.countDocuments({ clientId, status: "OPEN" }),
    ]);

    const stats = new Map(perMonitorRows.map((r) => [String(r._id), r]));

    // Paused monitors are counted as paused; the rest by their last known health
    const counts = { total: monitors.length, active: 0, paused: 0, up: 0, down: 0, unknown: 0 };
    for (const m of monitors) {
      if (m.status === "PAUSED") {
        counts.paused++;
        continue;
      }
      counts.active++;
      counts[(m.health?.status ?? "UNKNOWN").toLowerCase()]++;
    }

    // Overall totals are the per-monitor rows added together
    const t = { total: 0, successful: 0, responseTimeSum: 0 };
    for (const row of perMonitorRows) {
      t.total += row.total;
      t.successful += row.successful;
      t.responseTimeSum += (row.avg ?? 0) * row.successful;
    }
    const avgResponseTime = t.successful ? t.responseTimeSum / t.successful : null;

    return res.status(200).json({
      success: true,
      message: "Overview fetched",
      overview: {
        range: range.key,
        from: range.from,
        to: range.to,
        monitors: counts,
        openIncidents,
        checks: { total: t.total, failed: t.total - t.successful },
        uptimePercent: uptimePercent(t.total, t.total - t.successful),
        avgResponseTimeMs: round(avgResponseTime),
        perMonitor: monitors.map((m) => {
          const s = stats.get(String(m._id));
          const total = s?.total ?? 0;
          return {
            id: m._id,
            name: m.name,
            status: m.status,
            health: m.health?.status ?? "UNKNOWN",
            checks: total,
            uptimePercent: s ? uptimePercent(total, total - s.successful) : null,
            avgResponseTimeMs: round(s?.avg),
          };
        }),
      },
    });
  } catch (error) {
    next(error);
  }
};
