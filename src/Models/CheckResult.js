import mongoose from "mongoose";

// Results are deleted automatically after this many days. Changing the value later
// needs the TTL index rebuilt (db.checkresults.dropIndex("checkedAt_1")); use the same
// value for the API and the worker.
const retentionDays = Number(process.env.RESULT_RETENTION_DAYS) || 30;

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
checkResultSchema.index({ checkedAt: 1 }, { expireAfterSeconds: retentionDays * 24 * 60 * 60 });

export default mongoose.model("CheckResult", checkResultSchema);
