import mongoose from "mongoose";

export const HTTP_METHODS = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"];

const headerSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    value: { type: String, required: true },
  },
  { _id: false }
);

const monitorSchema = new mongoose.Schema(
  {
    // Every query on this collection must filter by clientId (tenant isolation)
    clientId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Client",
      required: true,
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "ClientUser",
      required: true,
    },
    name: {
      type: String,
      required: true,
      trim: true,
      maxlength: 100,
    },
    url: {
      type: String,
      required: true,
      maxlength: 2048,
    },
    method: {
      type: String,
      enum: HTTP_METHODS,
      default: "GET",
    },
    headers: {
      type: [headerSchema],
      default: [],
    },
    body: {
      type: String,
      default: null,
      maxlength: 10000,
    },
    expectedStatus: {
      type: Number,
      default: 200,
      min: 100,
      max: 599,
    },
    intervalSeconds: {
      type: Number,
      default: 300,
    },
    timeoutSeconds: {
      type: Number,
      default: 10,
    },
    status: {
      type: String,
      enum: ["ACTIVE", "PAUSED"],
      default: "ACTIVE",
    },
    // Written only by the worker after each check; never set from request bodies
    health: {
      status: {
        type: String,
        enum: ["UNKNOWN", "UP", "DOWN"],
        default: "UNKNOWN",
      },
      lastCheckedAt: Date,
      lastStatusCode: Number,
      lastResponseTimeMs: Number,
      lastErrorType: String,
      lastErrorMessage: String,
      consecutiveFailures: {
        type: Number,
        default: 0,
      },
    },
  },
  { timestamps: true }
);

monitorSchema.index({ clientId: 1, createdAt: -1 });
monitorSchema.index({ clientId: 1, status: 1 });

export default mongoose.model("Monitor", monitorSchema);
