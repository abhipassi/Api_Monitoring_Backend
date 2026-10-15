import mongoose from "mongoose";

import Client from "../Models/clients.js";
import ClientUser from "../Models/ClientUser.js";
import PlanRequest from "../Models/PlanRequest.js";
import { planChangeWarnings, planName } from "../Services/planService.js";
import { recordAudit } from "../Services/auditService.js";
import { resyncClientSchedules } from "../Services/monitorQueue.js";
import sendEmail from "../utils/sendEmail.js";
import { planRequestDecidedEmail } from "../utils/emailTemplates.js";
import { toPlanRequestResponse } from "./billingController.js";

const STATUSES = ["PENDING", "APPROVED", "REJECTED", "CANCELED"];
const badRequest = (res, message) => res.status(400).json({ success: false, message });

export const listPlanRequests = async (req, res, next) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 20));
    const filter = {};

    if (req.query.status) {
      if (!STATUSES.includes(req.query.status)) return badRequest(res, `Status must be one of ${STATUSES.join(", ")}`);
      filter.status = req.query.status;
    }
    if (req.query.clientId) {
      if (!mongoose.isValidObjectId(req.query.clientId)) return badRequest(res, "clientId is not valid");
      filter.clientId = req.query.clientId;
    }

    const [requests, total, pending] = await Promise.all([
      PlanRequest.find(filter).sort({ createdAt: -1, _id: -1 }).skip((page - 1) * limit).limit(limit).lean(),
      PlanRequest.countDocuments(filter),
      PlanRequest.countDocuments({ status: "PENDING" }),
    ]);

    return res.status(200).json({
      success: true,
      message: "Plan requests fetched",
      requests: requests.map(toPlanRequestResponse),
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
      pendingCount: pending,
    });
  } catch (error) {
    next(error);
  }
};

const decide = (approved) => async (req, res, next) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(404).json({ success: false, message: "Plan request not found" });
    }

    const { note } = req.body;
    if (note !== undefined && note !== null && (typeof note !== "string" || note.length > 1000)) {
      return badRequest(res, "Note must be text of at most 1000 characters");
    }

    const actor = req.user.doc;

    // One step, so two staff members can't both decide on the same request
    const request = await PlanRequest.findOneAndUpdate(
      { _id: req.params.id, status: "PENDING" },
      {
        status: approved ? "APPROVED" : "REJECTED",
        decidedBy: actor._id,
        decidedByName: actor.name,
        decidedAt: new Date(),
        decisionNote: note?.trim() || undefined,
      },
      { returnDocument: "after" }
    );

    if (!request) {
      const exists = await PlanRequest.exists({ _id: req.params.id });
      return res.status(exists ? 409 : 404).json({
        success: false,
        message: exists ? "This request has already been decided" : "Plan request not found",
      });
    }

    let warnings = [];
    const client = await Client.findById(request.clientId);

    if (approved && client) {
      const previousPlan = client.plan;
      client.plan = request.toPlan;
      await client.save();
      await resyncClientSchedules(client._id);
      warnings = await planChangeWarnings(client._id, client.plan);

      await recordAudit(req, {
        action: "client.update",
        targetType: "CLIENT",
        targetId: client._id,
        targetLabel: client.companyName || client.name,
        changes: { plan: { from: previousPlan, to: client.plan } },
      });
    }

    await recordAudit(req, {
      action: approved ? "plan-request.approve" : "plan-request.reject",
      targetType: "PLAN_REQUEST",
      targetId: request._id,
      targetLabel: `${request.clientName}: ${request.fromPlan} → ${request.toPlan}`,
      changes: note ? { decisionNote: { from: null, to: note.trim() } } : {},
    });

    const owners = await ClientUser.find({ clientId: request.clientId, role: "OWNER", status: "ACTIVE" }).select("name email").lean();
    const outcomes = await Promise.allSettled(
      owners.map((owner) =>
        sendEmail({
          to: owner.email,
          ...planRequestDecidedEmail({
            name: owner.name,
            request,
            approved,
            fromPlanName: planName(request.fromPlan),
            toPlanName: planName(request.toPlan),
          }),
        })
      )
    );
    outcomes.forEach((o) => o.status === "rejected" && console.error("Plan decision email failed:", o.reason?.message));

    return res.status(200).json({
      success: true,
      message: approved ? "Request approved and the plan was changed" : "Request rejected",
      request: toPlanRequestResponse(request),
      warnings,
    });
  } catch (error) {
    next(error);
  }
};

export const approvePlanRequest = decide(true);
export const rejectPlanRequest = decide(false);
