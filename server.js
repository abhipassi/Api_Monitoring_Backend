
import "dotenv/config";

import express from "express";
import cors from "cors";
import helmet from "helmet";

import { errorHandler, notFound } from "./src/Middlewares/error.middleware.js";
import connectDB from "./config/db.js";
import routes from "./src/Routes/index.js";
import { getQueue } from "./src/Services/monitorQueue.js";
import { ensureDefaultPlans } from "./src/Services/planCatalog.js";
import { dropGlobalResultExpiry } from "./src/Services/retentionService.js";

const app = express();

// Behind a reverse proxy / load balancer, set TRUST_PROXY to the number of proxies
// in front of the app so req.ip (used by rate limiting) is the real client IP.
if (process.env.TRUST_PROXY) {
    app.set("trust proxy", Number(process.env.TRUST_PROXY));
}
const PORT = process.env.PORT || 3004;


app.use(helmet());


// A browser sends its origin as scheme://host:port with no path or trailing slash, so FRONTEND_URL is
// reduced to that form before the comparison (a stray slash or "http:host" would otherwise block every request)
const corsOrigin = (() => {
    try {
        return new URL(process.env.FRONTEND_URL).origin;
    } catch {
        console.warn("FRONTEND_URL is not a valid URL; cross-origin requests will be blocked");
        return false;
    }
})();

app.use(cors({ origin: corsOrigin }));


app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true }));

// Express 5 leaves req.body undefined when a request has no (parsable) body
app.use((req, res, next) => {
    req.body ??= {};
    next();
});


app.get("/health-check", (req, res) => {
    res.status(200).json({
        success: true,
        message: "API is healthy",
        environment: process.env.NODE_ENV,
    });
});


app.use("/api", routes);


app.use(notFound);
app.use(errorHandler);


const startServer = async () => {
    try {
        await connectDB();
        await ensureDefaultPlans();
        await dropGlobalResultExpiry();

        // Connect to Redis now so the first monitor created after a restart can be scheduled.
        // The API still starts without it: monitors are saved and scheduled once Redis is back.
        try {
            getQueue();
        } catch (error) {
            console.error("Monitor queue unavailable:", error.message);
        }

        app.listen(PORT, () => {
            console.log(`Server is running on port ${PORT}`);
            console.log(`Environment: ${process.env.NODE_ENV}`);
        });
    } catch (error) {
        console.error("Server startup failed:", error.message);
        process.exit(1);
    }
};

startServer();
