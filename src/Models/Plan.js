import mongoose from "mongoose";

// A subscription plan. Staff create and edit these in the admin area; plans are archived, never
// deleted, so a customer (or an old plan request) never points at a plan that no longer exists.
const planSchema = new mongoose.Schema(
  {
    // Stored on customers and plan requests. Set when the plan is created and never changed.
    key: { type: String, required: true, unique: true, uppercase: true, trim: true },
    name: { type: String, required: true, trim: true },
    description: { type: String, trim: true, default: "" },
    features: { type: [String], default: [] },
    priceMonthly: { type: Number, required: true, min: 0 },
    limits: {
      maxMonitors: { type: Number, required: true, min: 1 },
      minIntervalSeconds: { type: Number, required: true, min: 1 },
      maxTimeoutSeconds: { type: Number, required: true, min: 1 },
      maxTeamMembers: { type: Number, required: true, min: 1 },
      retentionDays: { type: Number, required: true, min: 1 },
    },
    // Lowest first. A plan's position decides whether a change is an upgrade or a downgrade.
    sortOrder: { type: Number, default: 0 },
    isRecommended: { type: Boolean, default: false },
    // New customers start here. Exactly one plan is the default.
    isDefault: { type: Boolean, default: false },
    // An archived plan can't be chosen any more; customers already on it keep it.
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true }
);

export default mongoose.model("Plan", planSchema);
