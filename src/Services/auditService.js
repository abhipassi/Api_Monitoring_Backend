import AuditLog from "../Models/AuditLog.js";

// Builds { field: { from, to } } for the fields that actually changed
export const diffChanges = (before, after, fields) => {
  const changes = {};
  for (const field of fields) {
    const from = before?.[field];
    const to = after?.[field];
    if (JSON.stringify(from) !== JSON.stringify(to)) changes[field] = { from: from ?? null, to: to ?? null };
  }
  return changes;
};

// Records what an employee did. A failure to write the log is reported but never blocks the action
// that already happened.
export const recordAudit = async (req, { action, targetType, targetId, targetLabel, changes = {} }) => {
  try {
    const actor = req.user.doc;
    await AuditLog.create({
      actorId: actor._id,
      actorName: actor.name,
      actorEmail: actor.email,
      action,
      targetType,
      targetId,
      targetLabel,
      changes,
    });
  } catch (error) {
    console.error(`Audit log write failed (${action}):`, error.message);
  }
};
