import mongoose from "mongoose";

import Incident from "../Models/Incident.js";
import { badRequest } from "../utils/respond.js";
import { pageParams, paginationOf } from "../utils/listing.js";

const toIncidentResponse = (incident) => ({
  id: incident._id,
  monitorId: incident.monitorId,
  monitorName: incident.monitorName,
  monitorUrl: incident.monitorUrl,
  status: incident.status,
  resolution: incident.resolution ?? null,
  startedAt: incident.startedAt,
  resolvedAt: incident.resolvedAt ?? null,
  // Still counting while open
  durationSeconds: Math.round(
    ((incident.resolvedAt ?? new Date()).getTime() - incident.startedAt.getTime()) / 1000
  ),
  failureCount: incident.failureCount,
  cause: incident.cause?.errorType || incident.cause?.message
    ? {
        type: incident.cause.errorType ?? null,
        message: incident.cause.message ?? null,
        statusCode: incident.cause.statusCode ?? null,
      }
    : null,
});

export const listIncidents = async (req, res, next) => {
  try {
    const { page, limit } = pageParams(req.query);

    const filter = { clientId: req.user.clientId };

    if (typeof req.query.status === "string" && req.query.status) {
      const status = req.query.status.toUpperCase();
      if (!["OPEN", "RESOLVED"].includes(status)) {
        return badRequest(res, "Status filter must be OPEN or RESOLVED");
      }
      filter.status = status;
    }

    if (typeof req.query.monitorId === "string" && req.query.monitorId) {
      if (!mongoose.isValidObjectId(req.query.monitorId)) {
        return badRequest(res, "monitorId is not valid");
      }
      filter.monitorId = req.query.monitorId;
    }

    const [incidents, total, open] = await Promise.all([
      Incident.find(filter)
        .sort({ startedAt: -1, _id: -1 })
        .skip((page - 1) * limit)
        .limit(limit),
      Incident.countDocuments(filter),
      Incident.countDocuments({ clientId: req.user.clientId, status: "OPEN" }),
    ]);

    return res.status(200).json({
      success: true,
      message: "Incidents fetched",
      incidents: incidents.map(toIncidentResponse),
      pagination: paginationOf(page, limit, total),
      openCount: open,
    });
  } catch (error) {
    next(error);
  }
};

export const getIncident = async (req, res, next) => {
  try {
    const found = mongoose.isValidObjectId(req.params.id)
      ? await Incident.findOne({ _id: req.params.id, clientId: req.user.clientId })
      : null;

    // Another tenant's incident looks exactly like one that doesn't exist
    if (!found) {
      return res.status(404).json({ success: false, message: "Incident not found" });
    }

    return res.status(200).json({
      success: true,
      message: "Incident fetched",
      incident: toIncidentResponse(found),
    });
  } catch (error) {
    next(error);
  }
};
