import express from 'express'
import { listIncidents, getIncident } from '../Controllers/incidentController.js'
import { protect } from '../Middlewares/auth.middleware.js'

const router = express.Router()

router.use(protect('client'))

router.get('/', listIncidents)
router.get('/:id', getIncident)

export default router;
