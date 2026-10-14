import { Worker } from "bullmq";

import Monitor from "../Models/Monitor.js";
import Client from "../Models/clients.js";
import CheckResult from "../Models/CheckResult.js";
import { runCheck } from "./monitorCheckService.js";
import { recordFailure, recordRecovery } from "./incidentService.js";
import {
  QUEUE_NAME,
  createRedisConnection,
  queuePrefix,
  unscheduleMonitor,
} from "./monitorQueue.js";

// Handles one scheduled check. Exported for tests.
export const processCheckJob = async (job) => {
  const { monitorId } = job.data;

  const monitor = await Monitor.findById(monitorId);

  // Deleted or paused since the job was queued: the schedule is stale, so remove it
  if (!monitor || monitor.status !== "ACTIVE") {
    await unscheduleMonitor(monitorId);
    return { skipped: "monitor not active" };
  }

  const client = await Client.findById(monitor.clientId).select("status");
  if (!client || client.status !== "ACTIVE") {
    // Keep the schedule; reconcileSchedules() drops or restores it as the client's status changes
    return { skipped: "client not active" };
  }

  const result = await runCheck(monitor);
  const failuresBefore = monitor.health?.consecutiveFailures ?? 0;

  await CheckResult.create({
    monitorId: monitor._id,
    clientId: monitor.clientId,
    checkedAt: result.checkedAt,
    success: result.success,
    statusCode: result.statusCode,
    responseTimeMs: result.responseTimeMs,
    ...(result.error ? { error: result.error } : {}),
  });

  const update = {
    $set: {
      "health.status": result.success ? "UP" : "DOWN",
      "health.lastCheckedAt": result.checkedAt,
      "health.lastStatusCode": result.statusCode,
      "health.lastResponseTimeMs": result.responseTimeMs,
      "health.lastErrorType": result.error?.type ?? null,
      "health.lastErrorMessage": result.error?.message ?? null,
    },
  };
  if (result.success) update.$set["health.consecutiveFailures"] = 0;
  else update.$inc = { "health.consecutiveFailures": 1 };

  // Not save(): the monitor may have been edited while the check was running.
  // The returned streak is atomic, so parallel checks can't both think they crossed the threshold.
  const updated = await Monitor.findOneAndUpdate({ _id: monitor._id }, update, {
    returnDocument: "after",
    projection: { "health.consecutiveFailures": 1 },
  });
  if (!updated) return { skipped: "monitor deleted during check" };

  // A failed alert must never fail the check itself, so errors are logged and swallowed
  try {
    if (!result.success) {
      await recordFailure(monitor, updated.health.consecutiveFailures, result);
    } else if (failuresBefore > 0) {
      // Only monitors that were failing can have an open incident, so healthy ones skip this query
      await recordRecovery(monitor, result);
    }
  } catch (error) {
    console.error(`Incident handling failed for monitor ${monitor._id}:`, error.message);
  }

  return { success: result.success, statusCode: result.statusCode };
};

export const createMonitorWorker = ({ concurrency = 20 } = {}) => {
  const worker = new Worker(QUEUE_NAME, processCheckJob, {
    connection: createRedisConnection({ forWorker: true }),
    prefix: queuePrefix(),
    concurrency,
  });

  worker.on("failed", (job, error) => {
    console.error(`Check job ${job?.id} failed:`, error.message);
  });
  worker.on("error", (error) => {
    console.error("Worker error:", error.message);
  });

  return worker;
};
