import express from 'express'
import { clientRegister, clientLogin, clientMe } from '../Controllers/clientAuthController.js'
import {
    clientChangePassword,
    clientForgotPassword,
    clientResetPassword,
} from '../Controllers/passwordController.js'
import { protectAllowPasswordChange } from '../Middlewares/auth.middleware.js'
import {
    loginAccountLimiter,
    loginIpLimiter,
    registerLimiter,
    forgotPasswordLimiter,
    forgotPasswordEmailLimiter,
    resetPasswordLimiter,
    changePasswordLimiter,
} from '../Middlewares/rateLimit.middleware.js'

const router = express.Router()

router.post('/register', registerLimiter, clientRegister)
router.post('/login', loginIpLimiter, loginAccountLimiter, clientLogin)
router.post('/forgot-password', forgotPasswordLimiter, forgotPasswordEmailLimiter, clientForgotPassword)
router.post('/reset-password', resetPasswordLimiter, clientResetPassword)

// Reachable while the emailed password still has to be changed
router.get('/me', protectAllowPasswordChange('client'), clientMe)
router.post('/change-password', protectAllowPasswordChange('client'), changePasswordLimiter, clientChangePassword)

export default router;
