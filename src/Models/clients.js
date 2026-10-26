import mongoose from "mongoose";

const clientSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
    },
    email: {
      type: String,
      required: true,
      lowercase: true,
      trim: true,
    },
    companyName: {
      type: String,
      trim: true,
    },
    // The key of a Plan (see Models/Plan.js). Checked against the plans when it is set.
    plan: {
      type: String,
      default: "FREE",
    },
    status: {
      type: String,
      enum: ["ACTIVE", "SUSPENDED"],
      default: "ACTIVE",
    },
    // Filled in by a payment provider integration. While BILLING_PROVIDER is "none" nothing writes it,
    // and plan changes are made by staff approving a plan request.
    subscription: {
      provider: { type: String, default: "none" },
      status: {
        type: String,
        enum: ["NONE", "ACTIVE", "PAST_DUE", "CANCELED"],
        default: "NONE",
      },
      currentPeriodEnd: Date,
      cancelAtPeriodEnd: { type: Boolean, default: false },
      externalCustomerId: String,
      externalSubscriptionId: String,
    },
  },
  { timestamps: true }
);

export default mongoose.model("Client", clientSchema);