import { app } from "./app.js";
import { env } from "./config/env.js";

const server = app.listen(env.PORT, "127.0.0.1", () => {
    console.log(`Relay API running on port ${env.PORT} (RateLimit: ${env.RATE_LIMIT_MAX_REQUESTS} req / ${env.RATE_LIMIT_WINDOW_SECONDS}s)`);
});

function shutdown(signal: string) {
    console.log(`Received ${signal}. Shutting down Relay API...`);

    server.close(() => {
        console.log("Relay API stopped.");
        process.exit(0);
    });
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
