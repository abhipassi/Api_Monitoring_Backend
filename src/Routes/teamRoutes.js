import express from 'express'
import {
    listTeam,
    addTeamMember,
    updateTeamMember,
    removeTeamMember,
    resendCredentials,
} from '../Controllers/teamController.js'
import { protect, requireClientRole } from '../Middlewares/auth.middleware.js'
import { teamEmailLimiter } from '../Middlewares/rateLimit.middleware.js'

const router = express.Router()

router.use(protect('client'))

// Everyone on the account can see who is on the team; only owners change it
router.get('/', listTeam)
router.post('/', requireClientRole('OWNER'), teamEmailLimiter, addTeamMember)
router.patch('/:id', requireClientRole('OWNER'), updateTeamMember)
router.delete('/:id', requireClientRole('OWNER'), removeTeamMember)
router.post('/:id/resend-credentials', requireClientRole('OWNER'), teamEmailLimiter, resendCredentials)

export default router;
