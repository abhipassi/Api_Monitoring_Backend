import mongoose from "mongoose";

const incidentSchema = new mongoose.Schema(
  {
    // Every query on this collection must filter by clientId (tenant isolation)
    clientId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Client",
      required: true,
    },
    monitorId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Monitor",
      required: true,
    },
    // Snapshots, so the incident still reads correctly if the monitor is renamed later
    monitorName: { type: String, required: true },
    monitorUrl: { type: String, required: true },
    status: {
      type: String,
      enum: ["OPEN", "RESOLVED"],
      default: "OPEN",
    },
    // When the first failed check of the outage ran (not when the alert fired)
    startedAt: { type: Date, required: true },
    resolvedAt: Date,
    // RECOVERED: a check succeeded again. PAUSED: the monitor was paused while down.
    resolution: {
      type: String,
      enum: ["RECOVERED", "PAUSED"],
    },
    // The most recent failure while the incident has been open
    cause: {
      errorType: String,
      message: String,
      statusCode: Number,
    },
    failureCount: { type: Number, default: 0 },

    // Email bookkeeping. A claim (lock + attempt count) is taken before sending so two
    // workers never send the same alert, and a failed send is retried after the lock expires.
    downNotifiedAt: Date,
    downNotifyLockedUntil: Date,
    downNotifyAttempts: { type: Number, default: 0 },
    upNotifiedAt: Date,
    upNotifyLockedUntil: Date,
    upNotifyAttempts: { type: Number, default: 0 },
  },
  { timestamps: true }
);

// At most one open incident per monitor, enforced by the database so parallel workers can't duplicate it
incidentSchema.index(
  { monitorId: 1 },
  { unique: true, partialFilterExpression: { status: "OPEN" } }
);
incidentSchema.index({ clientId: 1, startedAt: -1 });
incidentSchema.index({ clientId: 1, status: 1, startedAt: -1 });
incidentSchema.index({ monitorId: 1, startedAt: -1 });

export default mongoose.model("Incident", incidentSchema);
