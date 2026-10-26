import mongoose from "mongoose";

// How long results are kept depends on the customer's plan (see Services/retentionService.js)

const checkResultSchema = new mongoose.Schema({
  monitorId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Monitor",
    required: true,
  },
  // Copied from the monitor so results can be queried per tenant without a join
  clientId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Client",
    required: true,
  },
  checkedAt: {
    type: Date,
    required: true,
  },
  success: {
    type: Boolean,
    required: true,
  },
  statusCode: {
    type: Number,
    default: null,
  },
  responseTimeMs: {
    type: Number,
    required: true,
  },
  error: {
    type: {
      type: String,
      default: undefined,
    },
    message: {
      type: String,
      default: undefined,
    },
  },
});

checkResultSchema.index({ monitorId: 1, checkedAt: -1 });
checkResultSchema.index({ clientId: 1, checkedAt: -1 });

export default mongoose.model("CheckResult", checkResultSchema);
