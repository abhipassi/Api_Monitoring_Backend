import mongoose from "mongoose";

const clientUserSchema = new mongoose.Schema(
  {
    clientId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Client",
      required: true,
      index: true,
    },
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
    passwordHash: {
      type: String,
      required: true,
      select: false,
    },
    role: {
      type: String,
      enum: ["OWNER", "MEMBER"],
      default: "OWNER",
    },
    status: {
      type: String,
      enum: ["INVITED", "ACTIVE", "DISABLED"],
      default: "ACTIVE",
    },
    // Set on accounts created with an emailed random password
    mustChangePassword: {
      type: Boolean,
      default: false,
    },
    // Tokens issued before this are rejected by auth middleware
    passwordChangedAt: Date,
    resetPasswordTokenHash: {
      type: String,
      select: false,
      index: { sparse: true },
    },
    resetPasswordExpires: {
      type: Date,
      select: false,
    },
    lastLoginAt: Date,
  },
  { timestamps: true }
);

clientUserSchema.index(
  { clientId: 1, email: 1 },
  { unique: true }
);

export default mongoose.model("ClientUser", clientUserSchema);