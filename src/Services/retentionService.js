import Client from "../Models/clients.js";
import CheckResult from "../Models/CheckResult.js";
import { getPlan, getPlans } from "./planCatalog.js";

const DAY_MS = 24 * 60 * 60 * 1000;

// Each plan keeps check history for its own number of days. Results older than that are deleted.
// Pass a plan key to clean up just that plan (used right after staff shorten its retention).
export const purgeExpiredResults = async (planKey) => {
  const plans = planKey ? [await getPlan(planKey)].filter(Boolean) : await getPlans();
  let deleted = 0;

  for (const plan of plans) {
    const cutoff = new Date(Date.now() - plan.limits.retentionDays * DAY_MS);
    const clientIds = (await Client.find({ plan: plan.key }).select("_id").lean()).map((c) => c._id);

    for (let i = 0; i < clientIds.length; i += 500) {
      const result = await CheckResult.deleteMany({ clientId: { $in: clientIds.slice(i, i + 500) }, checkedAt: { $lt: cutoff } });
      deleted += result.deletedCount;
    }
  }
  return deleted;
};

// Results used to expire through one database-wide TTL index (the same days for everybody).
// That would delete history a longer plan is allowed to keep, so remove it. Safe to run every start.
export const dropGlobalResultExpiry = async () => {
  try {
    const indexes = await CheckResult.collection.indexes();
    if (indexes.some((index) => index.name === "checkedAt_1" && index.expireAfterSeconds !== undefined)) {
      await CheckResult.collection.dropIndex("checkedAt_1");
      console.log("Removed the global check-result expiry; each plan's retention is used instead");
    }
  } catch (error) {
    // The collection doesn't exist yet (fresh database): nothing to remove
    if (error.codeName !== "NamespaceNotFound") console.error("Could not remove the global result expiry:", error.message);
  }
};
