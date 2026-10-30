import { startApiServer } from "./apiServer.js";

const server = startApiServer();

function shutdown(signal: string) {
    console.log(`Received ${signal}. Shutting down Relay API...`);

    server.close(() => {
        console.log("Relay API stopped.");
        process.exit(0);
    });
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
