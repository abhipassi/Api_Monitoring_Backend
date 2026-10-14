// Limits per Client.plan. Adjust these numbers to match what each plan sells.
export const PLAN_LIMITS = {
  FREE: {
    maxMonitors: 5,
    minIntervalSeconds: 300,
    maxTimeoutSeconds: 30,
  },
  STARTER: {
    maxMonitors: 50,
    minIntervalSeconds: 60,
    maxTimeoutSeconds: 30,
  },
  ENTERPRISE: {
    maxMonitors: 500,
    minIntervalSeconds: 30,
    maxTimeoutSeconds: 60,
  },
};

// No plan can check less often than once a day
export const MAX_INTERVAL_SECONDS = 24 * 60 * 60;

export const getPlanLimits = (plan) => PLAN_LIMITS[plan] || PLAN_LIMITS.FREE;
