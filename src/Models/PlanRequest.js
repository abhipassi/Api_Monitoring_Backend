import mongoose from "mongoose";
import { PLAN_KEYS } from "../../config/plans.js";

// A customer asking to move to another plan. This is how plans change until a payment
// provider is connected: staff approve or reject it in the admin area.
const planRequestSchema = new mongoose.Schema(
  {
    clientId: { type: mongoose.Schema.Types.ObjectId, ref: "Client", required: true },
    requestedBy: { type: mongoose.Schema.Types.ObjectId, ref: "ClientUser", required: true },
    // Snapshots: names and plans can change before staff look at it
    clientName: { type: String, required: true },
    requestedByName: { type: String, required: true },
    requestedByEmail: { type: String, required: true },
    fromPlan: { type: String, enum: PLAN_KEYS, required: true },
    toPlan: { type: String, enum: PLAN_KEYS, required: true },
    note: { type: String, maxlength: 1000 },
    status: {
      type: String,
      enum: ["PENDING", "APPROVED", "REJECTED", "CANCELED"],
      default: "PENDING",
    },
    decidedBy: { type: mongoose.Schema.Types.ObjectId, ref: "Employees" },
    decidedByName: String,
    decidedAt: Date,
    decisionNote: { type: String, maxlength: 1000 },
  },
  { timestamps: true }
);

// A client can have only one open request at a time, enforced by the database
planRequestSchema.index(
  { clientId: 1 },
  { unique: true, partialFilterExpression: { status: "PENDING" } }
);
planRequestSchema.index({ status: 1, createdAt: -1 });
planRequestSchema.index({ clientId: 1, createdAt: -1 });

export default mongoose.model("PlanRequest", planRequestSchema);
