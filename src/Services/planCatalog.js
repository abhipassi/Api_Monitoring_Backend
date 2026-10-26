import Plan from "../Models/Plan.js";
import { getBillingCurrency, seedPlans } from "../../config/plans.js";

// Plans are read often (every monitor save, every schedule) and change rarely, so they are cached
// in memory for a few seconds. The API clears its cache when staff save a plan; the worker is a
// separate process and simply picks the change up when its cache expires.
const CACHE_MS = 5000;
let cache = { at: 0, plans: [] };

export const clearPlanCache = () => {
  cache = { at: 0, plans: [] };
};

// Every plan (archived too), lowest first
export const getPlans = async () => {
  if (Date.now() - cache.at > CACHE_MS) {
    const plans = await Plan.find().sort({ sortOrder: 1, createdAt: 1 }).lean();
    cache = { at: Date.now(), plans };
  }
  return cache.plans;
};

export const getPlan = async (key) => (await getPlans()).find((p) => p.key === key) ?? null;

export const getDefaultPlan = async () => {
  const plans = await getPlans();
  return plans.find((p) => p.isDefault && p.isActive) ?? plans.find((p) => p.isActive) ?? plans[0];
};

// The limits that apply to a customer on this plan. An unknown key (it shouldn't happen) is
// treated like the default plan rather than crashing.
export const getPlanLimits = async (key) => ((await getPlan(key)) ?? (await getDefaultPlan())).limits;

export const planName = async (key) => (await getPlan(key))?.name ?? key;

// key -> position, to tell an upgrade from a downgrade
export const getPlanRanks = async () => new Map((await getPlans()).map((p, index) => [p.key, index]));

// A plan someone may choose today
export const isActivePlan = async (key) => Boolean((await getPlan(key))?.isActive);

// Run when the API or worker starts: the first time there are no plans, create the starting ones
export const ensureDefaultPlans = async () => {
  if ((await Plan.estimatedDocumentCount()) === 0) {
    try {
      await Plan.insertMany(seedPlans(), { ordered: false });
    } catch (error) {
      // The API and the worker can start together and both try; the unique key keeps it to one set
      if (error.code !== 11000 && !error.writeErrors?.every((e) => e.code === 11000)) throw error;
    }
  }
  clearPlanCache();
};

// How a plan is shown to the website (customers and staff)
export const toPlanResponse = (plan) => ({
  key: plan.key,
  name: plan.name,
  description: plan.description ?? "",
  features: plan.features ?? [],
  priceMonthly: plan.priceMonthly,
  currency: getBillingCurrency(),
  limits: plan.limits,
  sortOrder: plan.sortOrder,
  isRecommended: plan.isRecommended,
  isDefault: plan.isDefault,
  isActive: plan.isActive,
});
