// The plan catalog: limits and prices for each Client.plan. The website reads this through
// GET /api/meta, so nothing about plans is repeated in the frontend.

// Prices are placeholders until you decide them. Set PLAN_PRICE_STARTER / PLAN_PRICE_ENTERPRISE
// and BILLING_CURRENCY in .env, then PLAN_PRICES_CONFIRMED=true to hide the "sample pricing" notice.
const SAMPLE_PRICES = { FREE: 0, STARTER: 19, ENTERPRISE: 99 };

const priceFor = (plan) => {
  const raw = process.env[`PLAN_PRICE_${plan}`];
  const value = raw === undefined || raw === "" ? NaN : Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : SAMPLE_PRICES[plan];
};

// Listed from lowest to highest; a plan's position is its rank (used to tell upgrades from downgrades)
const PLAN_DEFINITIONS = [
  {
    key: "FREE",
    name: "Free",
    limits: { maxMonitors: 5, minIntervalSeconds: 300, maxTimeoutSeconds: 30, maxTeamMembers: 2 },
  },
  {
    key: "STARTER",
    name: "Starter",
    limits: { maxMonitors: 50, minIntervalSeconds: 60, maxTimeoutSeconds: 30, maxTeamMembers: 10 },
  },
  {
    key: "ENTERPRISE",
    name: "Enterprise",
    limits: { maxMonitors: 500, minIntervalSeconds: 30, maxTimeoutSeconds: 60, maxTeamMembers: 100 },
  },
];

export const PLAN_KEYS = PLAN_DEFINITIONS.map((p) => p.key);

export const PLAN_LIMITS = Object.fromEntries(PLAN_DEFINITIONS.map((p) => [p.key, p.limits]));

// No plan can check less often than once a day
export const MAX_INTERVAL_SECONDS = 24 * 60 * 60;

export const getPlanLimits = (plan) => PLAN_LIMITS[plan] || PLAN_LIMITS.FREE;

export const planRank = (plan) => PLAN_KEYS.indexOf(plan);

export const getBillingCurrency = () => (process.env.BILLING_CURRENCY || "USD").toUpperCase();

export const pricesAreSample = () => process.env.PLAN_PRICES_CONFIRMED !== "true";

// Read per call, so prices changed in .env show up after a restart without code changes
export const getPlanCatalog = () =>
  PLAN_DEFINITIONS.map((p) => ({
    key: p.key,
    name: p.name,
    priceMonthly: priceFor(p.key),
    currency: getBillingCurrency(),
    limits: PLAN_LIMITS[p.key],
  }));

export const getPlanPrice = (plan) => (PLAN_KEYS.includes(plan) ? priceFor(plan) : 0);
