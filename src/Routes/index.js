import express from 'express'
import adminAuthRoutes from './adminAuthRoutes.js'
import clientAuthRoutes from './clientAuthRoutes.js'
import employeeRoutes from './employeeRoutes.js'
import adminRoutes from './adminRoutes.js'
import monitorRoutes from './monitorRoutes.js'
import incidentRoutes from './incidentRoutes.js'
import statsRoutes from './statsRoutes.js'
import teamRoutes from './teamRoutes.js'
import billingRoutes from './billingRoutes.js'
import { getMeta } from '../Controllers/metaController.js'

const router = express.Router()

// Public: plans, prices and allowed values for the website
router.get('/meta', getMeta)

router.use('/admin/auth', adminAuthRoutes)
router.use('/admin/employees', employeeRoutes)
router.use('/admin', adminRoutes)

router.use('/client/auth', clientAuthRoutes)
router.use('/client/monitors', monitorRoutes)
router.use('/client/incidents', incidentRoutes)
router.use('/client/stats', statsRoutes)
router.use('/client/team', teamRoutes)
router.use('/client/billing', billingRoutes)

export default router;
