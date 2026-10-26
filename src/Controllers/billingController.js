import mongoose from "mongoose";

import Employees from "../Models/employees.js";
import ClientUser from "../Models/ClientUser.js";
import PlanRequest from "../Models/PlanRequest.js";
import { getBillingCurrency, pricesAreSample } from "../../config/plans.js";
import { getPlan, getPlanRanks, isActivePlan, planName, toPlanResponse } from "../Services/planCatalog.js";
import { getBillingProvider } from "../Services/billing/index.js";
import { getUsage, planChangeWarnings } from "../Services/planService.js";
import { sendEmailToEach } from "../utils/sendEmail.js";
import { planRequestReceivedEmail } from "../utils/emailTemplates.js";
import { badRequest } from "../utils/respond.js";

// ranks: from getPlanRanks(); a higher rank is a more expensive plan, so moving up is an upgrade
export const toPlanRequestResponse = (r, ranks) => ({
  id: r._id,
  clientId: r.clientId,
  clientName: r.clientName,
  requestedBy: { name: r.requestedByName, email: r.requestedByEmail },
  fromPlan: r.fromPlan,
  toPlan: r.toPlan,
  direction: ranks.get(r.toPlan) > ranks.get(r.fromPlan) ? "UPGRADE" : "DOWNGRADE",
  note: r.note ?? null,
  status: r.status,
  decidedByName: r.decidedByName ?? null,
  decidedAt: r.decidedAt ?? null,
  decisionNote: r.decisionNote ?? null,
  createdAt: r.createdAt,
});

export const getBilling = async (req, res, next) => {
  try {
    const { client } = req;
    const provider = getBillingProvider();

    const [usage, requests, ranks, current] = await Promise.all([
      getUsage(client._id, client.plan),
      PlanRequest.find({ clientId: client._id }).sort({ createdAt: -1 }).limit(10).lean(),
      getPlanRanks(),
      getPlan(client.plan),
    ]);
    const pending = requests.find((r) => r.status === "PENDING");

    return res.status(200).json({
      success: true,
      message: "Billing fetched",
      billing: {
        plan: toPlanResponse(current),
        usage,
        subscription: {
          provider: client.subscription?.provider ?? "none",
          status: client.subscription?.status ?? "NONE",
          currentPeriodEnd: client.subscription?.currentPeriodEnd ?? null,
          cancelAtPeriodEnd: client.subscription?.cancelAtPeriodEnd ?? false,
        },
        paymentsEnabled: provider.enabled,
        currency: getBillingCurrency(),
        pricesAreSample: pricesAreSample(),
        pendingRequest: pending ? toPlanRequestResponse(pending, ranks) : null,
        recentRequests: requests.map((r) => toPlanRequestResponse(r, ranks)),
      },
    });
  } catch (error) {
    next(error);
  }
};

// Who hears about a new request: SALES_EMAIL if set, otherwise every staff member who can decide on it
const staffRecipients = async () => {
  const configured = (process.env.SALES_EMAIL || "").split(",").map((e) => e.trim()).filter(Boolean);
  if (configured.length) return configured.map((email) => ({ name: "there", email }));

  return Employees.find({
    status: "ACTIVE",
    is_deleted: false,
    $or: [{ role: "SUPER_ADMIN" }, { permissions: "plan-requests.manage" }],
  })
    .select("name email")
    .lean();
};

export const createPlanRequest = async (req, res, next) => {
  try {
    const { client } = req;
    const { plan, note } = req.body;

    if (!(await isActivePlan(plan))) return badRequest(res, "Choose one of the available plans");
    if (plan === client.plan) return badRequest(res, "You are already on this plan");
    if (note !== undefined && note !== null && (typeof note !== "string" || note.length > 1000)) {
      return badRequest(res, "Note must be text of at most 1000 characters");
    }

    const owner = await ClientUser.findById(req.user.id).select("name email").lean();

    let request;
    try {
      request = await PlanRequest.create({
        clientId: client._id,
        requestedBy: req.user.id,
        clientName: client.companyName || client.name,
        requestedByName: owner.name,
        requestedByEmail: owner.email,
        fromPlan: client.plan,
        toPlan: plan,
        note: note?.trim() || undefined,
      });
    } catch (error) {
      // The partial unique index allows one PENDING request per client
      if (error.code === 11000) {
        return res.status(409).json({
          success: false,
          message: "You already have a plan request waiting for review. Cancel it first to send a new one.",
        });
      }
      throw error;
    }

    const recipients = await staffRecipients();
    const [fromName, toName, ranks] = await Promise.all([planName(request.fromPlan), planName(request.toPlan), getPlanRanks()]);
    await sendEmailToEach(
      recipients,
      (person) =>
        planRequestReceivedEmail({
          name: person.name,
          request,
          fromPlanName: fromName,
          toPlanName: toName,
        }),
      "Plan request email failed"
    );

    return res.status(201).json({
      success: true,
      message: "Plan request sent. Our team will review it shortly.",
      request: toPlanRequestResponse(request, ranks),
      warnings: ranks.get(plan) < ranks.get(client.plan) ? await planChangeWarnings(client._id, plan) : [],
    });
  } catch (error) {
    next(error);
  }
};

export const cancelPlanRequest = async (req, res, next) => {
  try {
    const request = mongoose.isValidObjectId(req.params.id)
      ? await PlanRequest.findOneAndUpdate(
          { _id: req.params.id, clientId: req.client._id, status: "PENDING" },
          { status: "CANCELED", decidedAt: new Date() },
          { returnDocument: "after" }
        )
      : null;

    if (!request) {
      return res.status(404).json({ success: false, message: "No waiting plan request found" });
    }

    return res.status(200).json({ success: true, message: "Plan request canceled", request: toPlanRequestResponse(request, await getPlanRanks()) });
  } catch (error) {
    next(error);
  }
};

// Starts an online payment once a provider is connected (see src/Services/billing/index.js)
export const createCheckout = async (req, res, next) => {
  try {
    const provider = getBillingProvider();

    if (!provider.enabled) {
      return res.status(501).json({
        success: false,
        code: "PAYMENTS_NOT_ENABLED",
        message: "Online payments are not available yet. Send a plan request instead.",
      });
    }

    const { plan } = req.body;
    if (!(await isActivePlan(plan)) || plan === req.client.plan) return badRequest(res, "Choose a different plan");

    const base = process.env.FRONTEND_URL;
    const session = await provider.createCheckoutSession({
      client: req.client,
      owner: req.user.doc,
      planKey: plan,
      successUrl: `${base}/billing?payment=success`,
      cancelUrl: `${base}/billing?payment=canceled`,
    });

    return res.status(200).json({ success: true, message: "Checkout started", url: session.url });
  } catch (error) {
    next(error);
  }
};
