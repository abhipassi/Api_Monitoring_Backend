import express from 'express'
import adminAuthRoutes from './adminAuthRoutes.js'
import clientAuthRoutes from './clientAuthRoutes.js'
import employeeRoutes from './employeeRoutes.js'

const router = express.Router()

router.use('/admin/auth', adminAuthRoutes)
router.use('/admin/employees', employeeRoutes)
router.use('/client/auth', clientAuthRoutes)

export default router;
