import express from 'express'
import {
    createMonitor,
    listMonitors,
    getMonitor,
    updateMonitor,
    deleteMonitor,
    listMonitorResults,
} from '../Controllers/monitorController.js'
import { getMonitorStats, getMonitorChart } from '../Controllers/statsController.js'
import { protect } from '../Middlewares/auth.middleware.js'

const router = express.Router()

// Client users only. protect() also blocks accounts that still have their emailed password.
router.use(protect('client'))

router.post('/', createMonitor)
router.get('/', listMonitors)
router.get('/:id', getMonitor)
router.get('/:id/results', listMonitorResults)
router.get('/:id/stats', getMonitorStats)
router.get('/:id/chart', getMonitorChart)
router.patch('/:id', updateMonitor)
router.delete('/:id', deleteMonitor)

export default router;
