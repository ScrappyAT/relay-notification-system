import http from "http";
import { getMetrics } from "./registry.js";

export interface MetricsServerInstance {
  server: http.Server;
  port: number;
  close: () => Promise<void>;
}

/**
 * Starts a lightweight native HTTP server to expose Prometheus /metrics for non-API processes.
 */
export function startProcessMetricsServer(port: number, processName: string): Promise<MetricsServerInstance> {
  return new Promise((resolve, reject) => {
    const server = http.createServer(async (req, res) => {
      const url = req.url?.split("?")[0];

      if (req.method === "GET" && (url === "/metrics" || url === "/")) {
        try {
          const metrics = await getMetrics();
          res.setHeader("Content-Type", "text/plain; version=0.0.4; charset=utf-8");
          res.writeHead(200);
          res.end(metrics);
        } catch (err: any) {
          res.writeHead(500, { "Content-Type": "text/plain" });
          res.end(`Error generating metrics: ${err.message}`);
        }
        return;
      }

      if (req.method === "GET" && url === "/health") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "ok", process: processName }));
        return;
      }

      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ code: "NOT_FOUND", message: "Not found" }));
    });

    server.listen(port, () => {
      console.log(`[${processName}] Prometheus metrics server listening on port ${port}`);
      resolve({
        server,
        port,
        close: () =>
          new Promise<void>((resClose, rejClose) => {
            server.close((err) => (err ? rejClose(err) : resClose()));
          }),
      });
    });

    server.on("error", (err) => {
      reject(err);
    });
  });
}

