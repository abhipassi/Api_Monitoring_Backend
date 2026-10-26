// What a STAFF employee can be allowed to do (stored in Employees.permissions).
// SUPER_ADMIN can do everything and also manages employees, which is not a permission.
// The admin screens read this list from GET /api/admin/meta to build their checkboxes.
export const PERMISSIONS = {
  "clients.read": "View customers, their usage and incidents",
  "clients.manage": "Change a customer's plan or suspend a customer",
  "plan-requests.manage": "Approve or reject plan change requests",
  "plans.manage": "Create and edit plans, prices and limits",
  "audit.read": "View the audit log",
};

export const PERMISSION_KEYS = Object.keys(PERMISSIONS);
