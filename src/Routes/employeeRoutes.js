import express from 'express'
import { createEmployee, listEmployees, updateEmployee } from '../Controllers/employeeController.js'
import { protect, requireRole } from '../Middlewares/auth.middleware.js'

const router = express.Router()

// Only SUPER_ADMIN manages employees (requireRole always lets SUPER_ADMIN through)
router.use(protect('admin'), requireRole())

router.get('/', listEmployees)
router.post('/', createEmployee)
router.patch('/:id', updateEmployee)

export default router;
