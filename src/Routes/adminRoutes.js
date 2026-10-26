import express from 'express'
import { listClients, getClient, updateClient } from '../Controllers/adminClientController.js'
import {
    listPlanRequests,
    approvePlanRequest,
    rejectPlanRequest,
} from '../Controllers/adminPlanRequestController.js'
import { createPlan, listPlans, updatePlan } from '../Controllers/adminPlanController.js'
import { getPlatformStats, listAuditLogs } from '../Controllers/adminStatsController.js'
import { getMeta } from '../Controllers/metaController.js'
import { protect, requirePermission } from '../Middlewares/auth.middleware.js'

const router = express.Router()

// Every route here is for signed-in staff; what they may do depends on their permissions
// (SUPER_ADMIN passes every check). See config/permissions.js.
router.use(protect('admin'))

router.get('/meta', getMeta)
router.get('/stats', requirePermission('clients.read'), getPlatformStats)

router.get('/clients', requirePermission('clients.read'), listClients)
router.get('/clients/:id', requirePermission('clients.read'), getClient)
router.patch('/clients/:id', requirePermission('clients.manage'), updateClient)

router.get('/plan-requests', requirePermission('plan-requests.manage'), listPlanRequests)
router.post('/plan-requests/:id/approve', requirePermission('plan-requests.manage'), approvePlanRequest)
router.post('/plan-requests/:id/reject', requirePermission('plan-requests.manage'), rejectPlanRequest)

router.get('/plans', requirePermission('plans.manage'), listPlans)
router.post('/plans', requirePermission('plans.manage'), createPlan)
router.patch('/plans/:key', requirePermission('plans.manage'), updatePlan)

router.get('/audit-logs', requirePermission('audit.read'), listAuditLogs)

export default router;
