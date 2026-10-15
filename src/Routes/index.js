import express from 'express'
import adminAuthRoutes from './adminAuthRoutes.js'
import clientAuthRoutes from './clientAuthRoutes.js'
import employeeRoutes from './employeeRoutes.js'
import monitorRoutes from './monitorRoutes.js'
import incidentRoutes from './incidentRoutes.js'
import statsRoutes from './statsRoutes.js'

const router = express.Router()

router.use('/admin/auth', adminAuthRoutes)
router.use('/admin/employees', employeeRoutes)
router.use('/client/auth', clientAuthRoutes)
router.use('/client/monitors', monitorRoutes)
router.use('/client/incidents', incidentRoutes)
router.use('/client/stats', statsRoutes)

export default router;
