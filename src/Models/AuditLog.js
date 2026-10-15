import mongoose from "mongoose";

// A record of what staff changed about customers and employees. Append-only: nothing in the
// app edits or deletes entries.
const auditLogSchema = new mongoose.Schema({
  actorId: { type: mongoose.Schema.Types.ObjectId, ref: "Employees", required: true },
  // Kept as text so the entry still reads correctly if the employee is renamed or removed
  actorName: { type: String, required: true },
  actorEmail: { type: String, required: true },
  action: { type: String, required: true },
  targetType: { type: String, enum: ["CLIENT", "EMPLOYEE", "PLAN_REQUEST"], required: true },
  targetId: { type: mongoose.Schema.Types.ObjectId, required: true },
  targetLabel: { type: String },
  // { field: { from, to } }
  changes: { type: mongoose.Schema.Types.Mixed, default: {} },
  createdAt: { type: Date, default: Date.now },
});

auditLogSchema.index({ createdAt: -1 });
auditLogSchema.index({ targetType: 1, targetId: 1, createdAt: -1 });
auditLogSchema.index({ actorId: 1, createdAt: -1 });

export default mongoose.model("AuditLog", auditLogSchema);
