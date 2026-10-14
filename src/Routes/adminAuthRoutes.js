import express from 'express'
import { adminLogin, adminMe } from '../Controllers/adminAuthController.js'
import {
    adminChangePassword,
    adminForgotPassword,
    adminResetPassword,
} from '../Controllers/passwordController.js'
import { protectAllowPasswordChange } from '../Middlewares/auth.middleware.js'
import {
    loginAccountLimiter,
    loginIpLimiter,
    forgotPasswordLimiter,
    forgotPasswordEmailLimiter,
    resetPasswordLimiter,
    changePasswordLimiter,
} from '../Middlewares/rateLimit.middleware.js'

const router = express.Router()

router.post('/login', loginIpLimiter, loginAccountLimiter, adminLogin)
router.post('/forgot-password', forgotPasswordLimiter, forgotPasswordEmailLimiter, adminForgotPassword)
router.post('/reset-password', resetPasswordLimiter, adminResetPassword)

// Reachable while the emailed password still has to be changed
router.get('/me', protectAllowPasswordChange('admin'), adminMe)
router.post('/change-password', protectAllowPasswordChange('admin'), changePasswordLimiter, adminChangePassword)

export default router;
