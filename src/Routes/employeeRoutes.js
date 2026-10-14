import express from 'express'
import { createEmployee } from '../Controllers/employeeController.js'
import { protect, requireRole } from '../Middlewares/auth.middleware.js'

const router = express.Router()

// Only SUPER_ADMIN can add employees (requireRole always lets SUPER_ADMIN through)
router.use(protect('admin'), requireRole())

router.post('/', createEmployee)

export default router;
