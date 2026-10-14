// Runs the monitor checks. Start it next to the API:  npm run worker
// It can run on a different machine (or several) as long as it has the same .env.
import "dotenv/config";
import mongoose from "mongoose";

import connectDB from "./config/db.js";
import { createMonitorWorker } from "./src/Services/monitorWorker.js";
import { closeQueue, reconcileSchedules } from "./src/Services/monitorQueue.js";
import { sendPendingNotifications } from "./src/Services/incidentService.js";

const concurrency = Number(process.env.WORKER_CONCURRENCY) || 20;
const reconcileEveryMs = (Number(process.env.RECONCILE_INTERVAL_MINUTES) || 10) * 60 * 1000;

const reconcile = async () => {
    try {
        const r = await reconcileSchedules();
        console.log(`Schedules reconciled: ${r.scheduled} monitors (added ${r.added}, updated ${r.updated}, removed ${r.removed})`);
    } catch (error) {
        console.error("Schedule reconcile failed:", error.message);
    }
};

const start = async () => {
    await connectDB();

    const worker = createMonitorWorker({ concurrency });
    console.log(`Monitor worker started (concurrency ${concurrency})`);

    await reconcile();
    // Repairs drift: plan changes, suspended clients, and monitors whose schedule update
    // failed because Redis was briefly unreachable
    const timer = setInterval(reconcile, reconcileEveryMs);

    // Retries incident emails that failed to send (for example while SMTP was unreachable)
    const retryNotifications = async () => {
        try {
            const r = await sendPendingNotifications();
            if (r.sent) console.log(`Retried incident emails: ${r.sent} sent`);
        } catch (error) {
            console.error("Retrying incident emails failed:", error.message);
        }
    };
    const notifyTimer = setInterval(retryNotifications, 2 * 60 * 1000);

    let stopping = false;
    const shutdown = async (signal) => {
        if (stopping) return;
        stopping = true;
        console.log(`${signal} received, finishing running checks...`);
        clearInterval(timer);
        clearInterval(notifyTimer);
        try {
            await worker.close(); // waits for in-flight jobs
            await closeQueue();
            await mongoose.disconnect();
        } finally {
            process.exit(0);
        }
    };
    process.on("SIGINT", () => shutdown("SIGINT"));
    process.on("SIGTERM", () => shutdown("SIGTERM"));
};

start().catch((error) => {
    console.error("Worker startup failed:", error.message);
    process.exit(1);
});
