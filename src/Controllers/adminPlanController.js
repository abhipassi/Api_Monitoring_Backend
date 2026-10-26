import Client from "../Models/clients.js";
import Plan from "../Models/Plan.js";
import { PLAN_LIMIT_RANGES } from "../../config/plans.js";
import { clearPlanCache, getPlans, toPlanResponse } from "../Services/planCatalog.js";
import { planImpact } from "../Services/planService.js";
import { resyncPlanSchedules } from "../Services/monitorQueue.js";
import { purgeExpiredResults } from "../Services/retentionService.js";
import { diffChanges, recordAudit } from "../Services/auditService.js";
import { badRequest } from "../utils/respond.js";

const KEY_PATTERN = /^[A-Z][A-Z0-9_]{1,23}$/;

// Names used in error messages; the allowed ranges are in config/plans.js
const LIMIT_LABELS = {
  maxMonitors: "Monitors",
  minIntervalSeconds: "Fastest check interval",
  maxTimeoutSeconds: "Longest timeout",
  maxTeamMembers: "Team members",
  retentionDays: "History kept (days)",
};
const LIMIT_RULES = Object.fromEntries(
  Object.entries(PLAN_LIMIT_RANGES).map(([field, range]) => [field, { ...range, label: LIMIT_LABELS[field] }])
);

// The values that are compared and written to the audit log (limits are flattened)
const AUDITED_FIELDS = [
  "name", "description", "features", "priceMonthly", "sortOrder", "isRecommended", "isDefault", "isActive",
  ...Object.keys(LIMIT_RULES),
];
const flatten = (plan) => ({ ...plan, ...plan.limits });

// Checks the fields that were sent. Returns { errors } or { data } holding only what changed shape-wise.
const validatePlanInput = (body, { creating }) => {
  const errors = [];
  const data = {};
  const limits = {};

  if (creating) {
    const key = typeof body.key === "string" ? body.key.trim().toUpperCase() : "";
    if (!KEY_PATTERN.test(key)) errors.push("Key must be 2-24 characters: capital letters, digits or underscores, starting with a letter");
    else data.key = key;
  }

  if (creating || body.name !== undefined) {
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (!name) errors.push("Name is required");
    else if (name.length > 40) errors.push("Name must be at most 40 characters");
    else data.name = name;
  }

  if (body.description !== undefined) {
    if (typeof body.description !== "string" || body.description.trim().length > 160) errors.push("Description must be text of at most 160 characters");
    else data.description = body.description.trim();
  }

  if (body.features !== undefined) {
    const valid =
      Array.isArray(body.features) &&
      body.features.length <= 10 &&
      body.features.every((f) => typeof f === "string" && f.trim() && f.trim().length <= 80);
    if (!valid) errors.push("Features must be a list of up to 10 short lines (80 characters each)");
    else data.features = body.features.map((f) => f.trim());
  }

  if (creating || body.priceMonthly !== undefined) {
    const price = Number(body.priceMonthly);
    if (body.priceMonthly === "" || body.priceMonthly === null || !Number.isFinite(price) || price < 0 || price > 1000000) {
      errors.push("Price must be a number from 0 to 1,000,000");
    } else data.priceMonthly = Math.round(price * 100) / 100;
  }

  for (const [field, rule] of Object.entries(LIMIT_RULES)) {
    const given = body.limits?.[field];
    if (given === undefined && !creating) continue;
    if (typeof given === "boolean" || given === "" || given === null || !Number.isInteger(Number(given)) || Number(given) < rule.min || Number(given) > rule.max) {
      errors.push(`${rule.label} must be a whole number from ${rule.min} to ${rule.max}`);
    } else limits[field] = Number(given);
  }
  if (Object.keys(limits).length) data.limits = limits;

  if (body.sortOrder !== undefined) {
    if (!Number.isInteger(body.sortOrder) || Math.abs(body.sortOrder) > 1000) errors.push("Order must be a whole number between -1000 and 1000");
    else data.sortOrder = body.sortOrder;
  }

  for (const flag of ["isRecommended", "isDefault", "isActive"]) {
    if (body[flag] === undefined) continue;
    if (typeof body[flag] !== "boolean") errors.push(`${flag} must be true or false`);
    else data[flag] = body[flag];
  }

  return errors.length ? { errors } : { data };
};

const sendErrors = (res, errors) => badRequest(res, errors[0]);

export const listPlans = async (req, res, next) => {
  try {
    const [plans, counts] = await Promise.all([getPlans(), Client.aggregate([{ $group: { _id: "$plan", count: { $sum: 1 } } }])]);
    const customers = new Map(counts.map((c) => [c._id, c.count]));

    return res.status(200).json({
      success: true,
      message: "Plans fetched",
      plans: plans.map((plan) => ({ ...toPlanResponse(plan), customerCount: customers.get(plan.key) ?? 0 })),
    });
  } catch (error) {
    next(error);
  }
};

export const createPlan = async (req, res, next) => {
  try {
    const result = validatePlanInput(req.body, { creating: true });
    if (result.errors) return sendErrors(res, result.errors);
    const { data } = result;

    if (data.isDefault && data.isActive === false) return badRequest(res, "The default plan must be active");

    let plan;
    try {
      plan = await Plan.create({ ...data, limits: data.limits });
    } catch (error) {
      if (error.code === 11000) return res.status(409).json({ success: false, message: "A plan with this key already exists" });
      throw error;
    }

    // A single default, and a single recommended plan
    if (plan.isDefault) await Plan.updateMany({ _id: { $ne: plan._id } }, { isDefault: false });
    if (plan.isRecommended) await Plan.updateMany({ _id: { $ne: plan._id } }, { isRecommended: false });
    clearPlanCache();

    await recordAudit(req, {
      action: "plan.create",
      targetType: "PLAN",
      targetId: plan._id,
      targetLabel: plan.name,
      changes: diffChanges({}, flatten(plan.toObject()), AUDITED_FIELDS),
    });

    return res.status(201).json({
      success: true,
      message: "Plan created",
      plan: { ...toPlanResponse(plan.toObject()), customerCount: 0 },
    });
  } catch (error) {
    next(error);
  }
};

export const updatePlan = async (req, res, next) => {
  try {
    const plan = await Plan.findOne({ key: String(req.params.key).toUpperCase() });
    if (!plan) return res.status(404).json({ success: false, message: "Plan not found" });

    const result = validatePlanInput(req.body, { creating: false });
    if (result.errors) return sendErrors(res, result.errors);
    const { data } = result;
    delete data.key; // a plan's key never changes

    if (Object.keys(data).length === 0) return badRequest(res, "No valid fields to update");

    // Exactly one default plan, and it must be one people can pick
    if (data.isDefault === false && plan.isDefault) return badRequest(res, "Make another plan the default instead");
    if (data.isActive === false && (plan.isDefault || data.isDefault)) return badRequest(res, "The default plan can't be archived. Make another plan the default first");
    if (data.isDefault && !(data.isActive ?? plan.isActive)) return badRequest(res, "The default plan must be active");

    const before = flatten(plan.toObject());
    const { limits, ...fields } = data;
    plan.set(fields);
    if (limits) for (const [field, value] of Object.entries(limits)) plan.set(`limits.${field}`, value);
    await plan.save();

    if (plan.isDefault) await Plan.updateMany({ _id: { $ne: plan._id } }, { isDefault: false });
    if (data.isRecommended) await Plan.updateMany({ _id: { $ne: plan._id } }, { isRecommended: false });
    clearPlanCache();

    const after = flatten(plan.toObject());
    const changes = diffChanges(before, after, AUDITED_FIELDS);
    if (Object.keys(changes).length) {
      await recordAudit(req, { action: "plan.update", targetType: "PLAN", targetId: plan._id, targetLabel: plan.name, changes });
    }

    // Limits apply to everyone on the plan right away: re-time their checks and drop history
    // that is now older than the plan keeps
    if (changes.minIntervalSeconds) await resyncPlanSchedules(plan.key);
    if (changes.retentionDays) purgeExpiredResults(plan.key).catch((error) => console.error("Purge after plan edit failed:", error.message));

    const [counts, impact] = await Promise.all([Client.countDocuments({ plan: plan.key }), planImpact(plan.key)]);

    return res.status(200).json({
      success: true,
      message: "Plan updated",
      plan: { ...toPlanResponse(plan.toObject()), customerCount: counts },
      impact,
    });
  } catch (error) {
    next(error);
  }
};
