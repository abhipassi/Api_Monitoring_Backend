import { Queue } from "bullmq";
import IORedis from "ioredis";

import Monitor from "../Models/Monitor.js";
import Client from "../Models/clients.js";
import { getPlanLimits } from "../../config/plans.js";

// One repeating BullMQ job scheduler per ACTIVE monitor, with the monitor id as the
// scheduler id. A job carries only { monitorId }; the worker reads the current settings
// from MongoDB, which stays the source of truth. Redis only holds the timetable, and
// reconcileSchedules() rebuilds it from MongoDB, so a Redis flush loses nothing.

export const QUEUE_NAME = "monitor-checks";
export const JOB_NAME = "check";

// Lets several environments share one Redis server without touching each other's keys
export const queuePrefix = () => process.env.QUEUE_PREFIX || "apimon";

export const createRedisConnection = ({ forWorker = false } = {}) => {
  const url = process.env.REDIS_URL;
  if (!url) throw new Error("REDIS_URL is not set");

  // Workers wait for Redis forever; the API's queue fails fast so requests never hang
  const connection = new IORedis(
    url,
    forWorker
      ? { maxRetriesPerRequest: null }
      : { enableOfflineQueue: false, maxRetriesPerRequest: 1, retryStrategy: (n) => Math.min(n * 500, 5000) }
  );
  // Without a listener, ioredis prints an error for every failed reconnect attempt
  let lastLogged = 0;
  connection.on("error", (error) => {
    if (Date.now() - lastLogged > 30000) {
      lastLogged = Date.now();
      console.error("Redis connection error:", error.message);
    }
  });
  return connection;
};

let queue;
let queueConnection;
export const getQueue = () => {
  if (!queue) {
    queueConnection = createRedisConnection();
    queue = new Queue(QUEUE_NAME, {
      connection: queueConnection,
      prefix: queuePrefix(),
    });
    queue.on("error", () => {}); // connection errors are already logged once above
  }
  return queue;
};

export const closeQueue = async () => {
  if (queue) {
    await queue.close();
    queue = undefined;
    queueConnection = undefined;
  }
};

// A plan downgrade must not leave a monitor checking faster than the plan now allows
export const effectiveIntervalSeconds = (monitor, plan) =>
  Math.max(monitor.intervalSeconds, getPlanLimits(plan).minIntervalSeconds);

const scheduleInput = (monitor, plan) => [
  String(monitor._id),
  // The first check runs straight away, then every `every` ms
  { every: effectiveIntervalSeconds(monitor, plan) * 1000 },
  {
    name: JOB_NAME,
    data: { monitorId: String(monitor._id) },
    // A failed check is a result, not an error to retry; keep only recent failures for debugging
    opts: { attempts: 1, removeOnComplete: true, removeOnFail: { count: 200 } },
  },
];

export const scheduleMonitor = (monitor, plan) =>
  getQueue().upsertJobScheduler(...scheduleInput(monitor, plan));

export const unscheduleMonitor = (monitorId) => getQueue().removeJobScheduler(String(monitorId));

const REDIS_CALL_TIMEOUT_MS = 3000;

// BullMQ waits for a lost Redis connection forever, which would hang the API request.
// Fail at once when Redis isn't connected, and cap how long a single call may take.
const callRedis = (fn, timeoutMs = REDIS_CALL_TIMEOUT_MS) => {
  getQueue();
  if (queueConnection.status !== "ready") {
    return Promise.reject(new Error("Redis is not connected"));
  }

  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error("Redis call timed out")), timeoutMs);
  });
  return Promise.race([fn(), timeout]).finally(() => clearTimeout(timer));
};

// Used by the API after a monitor changes. Redis being down must not fail the request:
// MongoDB already has the change, and reconcileSchedules() fixes the timetable later.
export const syncMonitorSchedule = async (monitor, plan) => {
  try {
    await callRedis(() =>
      monitor.status === "ACTIVE" ? scheduleMonitor(monitor, plan) : unscheduleMonitor(monitor._id)
    );
    return true;
  } catch (error) {
    console.error(`Could not sync schedule for monitor ${monitor._id}:`, error.message);
    return false;
  }
};

export const removeMonitorSchedule = async (monitorId) => {
  try {
    await callRedis(() => unscheduleMonitor(monitorId));
    return true;
  } catch (error) {
    console.error(`Could not remove schedule for monitor ${monitorId}:`, error.message);
    return false;
  }
};

const inChunks = async (items, size, fn) => {
  for (let i = 0; i < items.length; i += size) {
    await Promise.all(items.slice(i, i + size).map(fn));
  }
};

// Makes Redis match MongoDB: every ACTIVE monitor of an ACTIVE client is scheduled at its
// effective interval, and every other scheduler is removed. Schedulers that are already
// correct are left alone, so a check's timing isn't disturbed.
export const reconcileSchedules = async () => {
  const q = getQueue();

  const existing = new Map();
  for (const scheduler of await q.getJobSchedulers(0, -1)) {
    existing.set(scheduler.key, scheduler.every);
  }

  const clients = new Map(
    (await Client.find({ status: "ACTIVE" }).select("plan").lean()).map((c) => [String(c._id), c.plan])
  );

  const wanted = new Map();
  const cursor = Monitor.find({ status: "ACTIVE" }).select("clientId intervalSeconds").lean().cursor();
  for await (const monitor of cursor) {
    const plan = clients.get(String(monitor.clientId));
    if (plan) wanted.set(String(monitor._id), monitor);
  }

  const toUpsert = [];
  for (const [id, monitor] of wanted) {
    const plan = clients.get(String(monitor.clientId));
    const every = effectiveIntervalSeconds(monitor, plan) * 1000;
    if (existing.get(id) !== every) toUpsert.push([monitor, plan, existing.has(id)]);
  }
  const toRemove = [...existing.keys()].filter((id) => !wanted.has(id));

  await inChunks(toUpsert, 100, ([monitor, plan]) => scheduleMonitor(monitor, plan));
  await inChunks(toRemove, 100, (id) => q.removeJobScheduler(id));

  return {
    scheduled: wanted.size,
    added: toUpsert.filter(([, , wasThere]) => !wasThere).length,
    updated: toUpsert.filter(([, , wasThere]) => wasThere).length,
    removed: toRemove.length,
  };
};

// After staff change a client's plan or suspend/restore it: update that client's schedules now
// instead of waiting for the next reconcile pass. Redis being down is logged, not fatal.
export const resyncClientSchedules = async (clientId) => {
  try {
    const client = await Client.findById(clientId).select("plan status").lean();
    const monitors = await Monitor.find({ clientId }).select("clientId intervalSeconds status").lean();

    await callRedis(async () => {
      const q = getQueue();
      await inChunks(monitors, 50, async (monitor) => {
        const id = String(monitor._id);
        if (!client || client.status !== "ACTIVE" || monitor.status !== "ACTIVE") {
          await q.removeJobScheduler(id);
          return;
        }
        const every = effectiveIntervalSeconds(monitor, client.plan) * 1000;
        const existing = await q.getJobScheduler(id);
        // Leave correct schedulers alone so their timing isn't disturbed
        if (existing?.every !== every) await scheduleMonitor(monitor, client.plan);
      });
    }, 60 * 1000); // a client can have hundreds of monitors
    return true;
  } catch (error) {
    console.error(`Could not resync schedules for client ${clientId}:`, error.message);
    return false;
  }
};
