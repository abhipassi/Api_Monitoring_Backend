import express from 'express'
import { getOverview } from '../Controllers/statsController.js'
import { protect } from '../Middlewares/auth.middleware.js'

const router = express.Router()

router.use(protect('client'))

router.get('/overview', getOverview)

export default router;
