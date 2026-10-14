import Incident from "../Models/Incident.js";
import CheckResult from "../Models/CheckResult.js";
import ClientUser from "../Models/ClientUser.js";
import sendEmail from "../utils/sendEmail.js";
import { incidentOpenedEmail, incidentResolvedEmail } from "../utils/emailTemplates.js";

// How many failed checks in a row open an incident. One failure is often just a blip.
const failureThreshold = () => Math.max(1, Number(process.env.INCIDENT_FAILURE_THRESHOLD) || 3);

const MAX_NOTIFY_ATTEMPTS = 5;
// A claimed email that wasn't confirmed sent can be retried after this long
const NOTIFY_LOCK_MS = 2 * 60 * 1000;
// Alerts older than this are no longer retried; telling someone about a day-old outage helps nobody
const RETRY_WINDOW_MS = 24 * 60 * 60 * 1000;

const NOTIFY_FIELDS = {
  down: { at: "downNotifiedAt", lock: "downNotifyLockedUntil", tries: "downNotifyAttempts", build: incidentOpenedEmail },
  up: { at: "upNotifiedAt", lock: "upNotifyLockedUntil", tries: "upNotifyAttempts", build: incidentResolvedEmail },
};

// The time of the first failed check in the current streak, so "down since" and the downtime
// are measured from when the outage began, not from when the third failure happened.
const streakStart = async (monitorId, consecutiveFailures) => {
  const first = await CheckResult.find({ monitorId })
    .sort({ checkedAt: -1 })
    .skip(consecutiveFailures - 1)
    .limit(1)
    .select("checkedAt")
    .lean();
  return first[0]?.checkedAt ?? null;
};

// Emails every active user of the client. Returns true when the alert needs no further attempts.
// Safe to call repeatedly and from several workers: the claim below lets one caller through.
export const notifyIncident = async (incidentId, kind) => {
  const fields = NOTIFY_FIELDS[kind];
  const now = new Date();

  if (kind === "up") {
    const incident = await Incident.findById(incidentId).lean();
    if (!incident || incident.upNotifiedAt) return false;

    if (!incident.downNotifiedAt) {
      // The "down" email may be in flight right now: wait, so the two arrive in order
      if (incident.downNotifyLockedUntil && incident.downNotifyLockedUntil > now) return false;
      // Otherwise the customer never heard about this outage (and, being resolved, it will no
      // longer be sent), so "it's back" would only confuse them
      await Incident.updateOne({ _id: incidentId, upNotifiedAt: null }, { upNotifiedAt: now });
      return true;
    }
  }

  const incident = await Incident.findOneAndUpdate(
    {
      _id: incidentId,
      [fields.at]: null,
      [fields.tries]: { $lt: MAX_NOTIFY_ATTEMPTS },
      $or: [{ [fields.lock]: null }, { [fields.lock]: { $lt: now } }],
    },
    { $set: { [fields.lock]: new Date(now.getTime() + NOTIFY_LOCK_MS) }, $inc: { [fields.tries]: 1 } },
    { returnDocument: "after" }
  );
  if (!incident) return false; // already sent, claimed by someone else, or out of attempts

  const recipients = await ClientUser.find({ clientId: incident.clientId, status: "ACTIVE" })
    .select("name email")
    .lean();

  if (recipients.length === 0) {
    console.warn(`Incident ${incident._id}: no active users to notify`);
    await Incident.updateOne({ _id: incident._id }, { [fields.at]: new Date() });
    return true;
  }

  const outcomes = await Promise.allSettled(
    recipients.map((user) =>
      sendEmail({ to: user.email, ...fields.build({ name: user.name, incident }) })
    )
  );

  outcomes.forEach((outcome, i) => {
    if (outcome.status === "rejected") {
      console.error(`Incident ${incident._id}: ${kind} email to ${recipients[i].email} failed:`, outcome.reason?.message);
    }
  });

  // Done once at least one person was reached; if nobody was, the lock expires and it's retried
  if (outcomes.some((o) => o.status === "fulfilled")) {
    await Incident.updateOne({ _id: incident._id }, { [fields.at]: new Date() });
    return true;
  }
  return false;
};

// Called by the worker after a failed check, with the monitor's updated failure streak.
export const recordFailure = async (monitor, consecutiveFailures, result) => {
  if (consecutiveFailures < failureThreshold()) return null;

  const cause = {
    errorType: result.error?.type,
    message: result.error?.message,
    statusCode: result.statusCode ?? undefined,
  };

  // Already open: just keep it current
  const open = await Incident.findOneAndUpdate(
    { monitorId: monitor._id, status: "OPEN" },
    { $max: { failureCount: consecutiveFailures }, $set: { cause } },
    { returnDocument: "after" }
  );
  if (open) return open;

  let incident;
  try {
    incident = await Incident.create({
      clientId: monitor.clientId,
      monitorId: monitor._id,
      monitorName: monitor.name,
      monitorUrl: monitor.url,
      startedAt: (await streakStart(monitor._id, consecutiveFailures)) ?? result.checkedAt,
      cause,
      failureCount: consecutiveFailures,
    });
  } catch (error) {
    if (error.code === 11000) return null; // another worker opened it first
    throw error;
  }

  await notifyIncident(incident._id, "down").catch((error) =>
    console.error(`Incident ${incident._id}: notify failed:`, error.message)
  );
  return incident;
};

// Called by the worker after a successful check on a monitor that had been failing.
export const recordRecovery = async (monitor, result) => {
  const incident = await Incident.findOneAndUpdate(
    { monitorId: monitor._id, status: "OPEN" },
    { $set: { status: "RESOLVED", resolvedAt: result.checkedAt, resolution: "RECOVERED" } },
    { returnDocument: "after" }
  );
  if (!incident) return null;

  await notifyIncident(incident._id, "up").catch((error) =>
    console.error(`Incident ${incident._id}: notify failed:`, error.message)
  );
  return incident;
};

// A monitor that is paused can't recover, so an open incident would stay open forever.
// Closes it quietly (no "recovered" email, because it didn't recover).
export const closeOpenIncident = async (monitorId, resolution = "PAUSED") => {
  const now = new Date();
  return Incident.updateOne(
    { monitorId, status: "OPEN" },
    { $set: { status: "RESOLVED", resolvedAt: now, resolution, upNotifiedAt: now } }
  );
};

export const deleteIncidentsForMonitor = (monitorId, clientId) =>
  Incident.deleteMany({ monitorId, clientId });

// Retries alerts whose email failed (SMTP down, wrong password, ...). The worker calls this on a timer.
export const sendPendingNotifications = async ({ limit = 50 } = {}) => {
  const since = new Date(Date.now() - RETRY_WINDOW_MS);
  let sent = 0;

  const pendingDown = await Incident.find({
    status: "OPEN",
    downNotifiedAt: null,
    downNotifyAttempts: { $lt: MAX_NOTIFY_ATTEMPTS },
    createdAt: { $gte: since },
  })
    .select("_id")
    .limit(limit)
    .lean();

  const pendingUp = await Incident.find({
    status: "RESOLVED",
    resolution: "RECOVERED",
    upNotifiedAt: null,
    resolvedAt: { $gte: since },
  })
    .select("_id")
    .limit(limit)
    .lean();

  for (const { _id } of pendingDown) if (await notifyIncident(_id, "down")) sent++;
  for (const { _id } of pendingUp) if (await notifyIncident(_id, "up")) sent++;

  return { checked: pendingDown.length + pendingUp.length, sent };
};
