
import "dotenv/config";

import express from "express";
import cors from "cors";
import helmet from "helmet";

import { errorHandler, notFound } from "./src/Middlewares/error.middleware.js";
import connectDB from "./config/db.js";
import routes from "./src/Routes/index.js";

const app = express();

// Behind a reverse proxy / load balancer, set TRUST_PROXY to the number of proxies
// in front of the app so req.ip (used by rate limiting) is the real client IP.
if (process.env.TRUST_PROXY) {
    app.set("trust proxy", Number(process.env.TRUST_PROXY));
}
const PORT = process.env.PORT || 3004;


app.use(helmet());


app.use(
    cors({
        origin: process.env.FRONTEND_URL,
    })
);


app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true }));


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
