// The starting plans, written to the database the first time the API or worker starts with no
// plans. After that, plans are edited by staff in the admin area and this file is not used.
//
// PLAN_PRICE_STARTER / PLAN_PRICE_ENTERPRISE in .env only set the first prices.
// RESULT_RETENTION_DAYS only sets the first retention.

const SAMPLE_PRICES = { FREE: 0, STARTER: 19, ENTERPRISE: 99 };

const firstPrice = (key) => {
  const raw = process.env[`PLAN_PRICE_${key}`];
  const value = raw === undefined || raw === "" ? NaN : Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : SAMPLE_PRICES[key];
};

export const seedPlans = () => {
  const retentionDays = Number(process.env.RESULT_RETENTION_DAYS) || 30;
  const plan = (key, name, sortOrder, limits, extra = {}) => ({
    key,
    name,
    sortOrder,
    priceMonthly: firstPrice(key),
    limits: { ...limits, retentionDays },
    ...extra,
  });

  return [
    plan("FREE", "Free", 0, { maxMonitors: 5, minIntervalSeconds: 300, maxTimeoutSeconds: 30, maxTeamMembers: 2 }, { isDefault: true }),
    plan("STARTER", "Starter", 1, { maxMonitors: 50, minIntervalSeconds: 60, maxTimeoutSeconds: 30, maxTeamMembers: 10 }),
    plan("ENTERPRISE", "Enterprise", 2, { maxMonitors: 500, minIntervalSeconds: 30, maxTimeoutSeconds: 60, maxTeamMembers: 100 }),
  ];
};

// No plan can check less often than once a day
export const MAX_INTERVAL_SECONDS = 24 * 60 * 60;

// The whole-number range allowed for each limit when staff edit a plan (also sent to the website)
export const PLAN_LIMIT_RANGES = {
  maxMonitors: { min: 1, max: 100000 },
  minIntervalSeconds: { min: 5, max: MAX_INTERVAL_SECONDS },
  maxTimeoutSeconds: { min: 1, max: 300 },
  maxTeamMembers: { min: 1, max: 100000 },
  retentionDays: { min: 1, max: 365 },
};

export const getBillingCurrency = () => (process.env.BILLING_CURRENCY || "USD").toUpperCase();

export const pricesAreSample = () => process.env.PLAN_PRICES_CONFIRMED !== "true";
