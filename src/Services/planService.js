import Monitor from "../Models/Monitor.js";
import ClientUser from "../Models/ClientUser.js";
import { getPlanCatalog, getPlanLimits } from "../../config/plans.js";

export const planName = (key) => getPlanCatalog().find((p) => p.key === key)?.name ?? key;

// What a client uses today against what its plan allows
export const getUsage = async (clientId, plan) => {
  const limits = getPlanLimits(plan);
  const [monitors, teamMembers] = await Promise.all([
    Monitor.countDocuments({ clientId }),
    ClientUser.countDocuments({ clientId, status: "ACTIVE" }),
  ]);
  return {
    monitors: { used: monitors, max: limits.maxMonitors },
    teamMembers: { used: teamMembers, max: limits.maxTeamMembers },
  };
};

// Plain-language notes about what would not fit on a plan. Nothing is deleted or switched off
// when a plan shrinks; these tell staff and owners what to expect.
export const planChangeWarnings = async (clientId, newPlanKey) => {
  const limits = getPlanLimits(newPlanKey);
  const name = planName(newPlanKey);
  const usage = await getUsage(clientId, newPlanKey);
  const warnings = [];

  if (usage.monitors.used > usage.monitors.max) {
    warnings.push(
      `${usage.monitors.used} monitors exist but the ${name} plan allows ${usage.monitors.max}. They keep running, but no new ones can be added until the number drops.`
    );
  }
  if (usage.teamMembers.used > usage.teamMembers.max) {
    warnings.push(
      `${usage.teamMembers.used} team members are active but the ${name} plan allows ${usage.teamMembers.max}. Nobody is removed, but no one new can be added until the number drops.`
    );
  }

  const tooFast = await Monitor.countDocuments({ clientId, intervalSeconds: { $lt: limits.minIntervalSeconds } });
  if (tooFast > 0) {
    warnings.push(
      `${tooFast} monitor${tooFast === 1 ? " checks" : "s check"} more often than the ${name} plan allows, so ${tooFast === 1 ? "it" : "they"} will run every ${limits.minIntervalSeconds} seconds instead.`
    );
  }

  return warnings;
};
