import express from 'express'
import {
    getBilling,
    createPlanRequest,
    cancelPlanRequest,
    createCheckout,
} from '../Controllers/billingController.js'
import { protect, requireClientRole } from '../Middlewares/auth.middleware.js'
import { planRequestLimiter } from '../Middlewares/rateLimit.middleware.js'

const router = express.Router()

// Billing is for account owners only
router.use(protect('client'), requireClientRole('OWNER'))

router.get('/', getBilling)
router.post('/plan-requests', planRequestLimiter, createPlanRequest)
router.delete('/plan-requests/:id', cancelPlanRequest)
router.post('/checkout', createCheckout)

export default router;
