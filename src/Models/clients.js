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
    plan: {
      type: String,
      enum: ["FREE", "STARTER", "ENTERPRISE"],
      default: "FREE",
    },
    status: {
      type: String,
      enum: ["ACTIVE", "SUSPENDED"],
      default: "ACTIVE",
    },
  },
  { timestamps: true }
);

export default mongoose.model("Client", clientSchema);