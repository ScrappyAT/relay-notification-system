import type { RequestHandler } from "express";

const loopback = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);
export function isLocalHost(value: string): boolean {
  try {
    return ["localhost", "127.0.0.1", "[::1]"].includes(new URL(value).hostname);
  } catch { return false; }
}

// Do not trust forwarded headers: the demonstration has no reverse proxy or auth.
export const localOnly: RequestHandler = (req, res, next) => {
  if (!loopback.has(req.socket.remoteAddress ?? "") ||
      !isLocalHost(`http://${req.headers.host ?? ""}`) ||
      (req.headers.origin && !isLocalHost(req.headers.origin)) ||
      req.headers["sec-fetch-site"] === "cross-site") {
    res.status(403).json({ code: "LOCAL_ONLY", message: "Relay demo access is limited to localhost." });
    return;
  }
  res.setHeader("Cache-Control", "no-store");
  next();
};
