import { NextRequest } from "next/server";

export const dynamic = "force-dynamic";
const local = (url: URL) => ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
const allowed = new Map([
  ["dashboard/customers", ["GET"]], ["dashboard/overview", ["GET"]],
  ["dashboard/notifications", ["GET"]], ["dashboard/preferences", ["GET"]],
  ["dashboard/monitoring", ["GET"]], ["notifications", ["POST"]],
  ["recipients/preferences", ["GET", "PUT"]],
]);

async function proxy(request: NextRequest, context: { params: Promise<{ path: string[] }> }) {
  const headers = { "Cache-Control": "no-store" };
  try {
    const host = new URL(`http://${request.headers.get("host") ?? ""}`);
    const origin = request.headers.get("origin");
    if (!local(host) || (origin && new URL(origin).host !== host.host) || request.headers.get("sec-fetch-site") === "cross-site") {
      return Response.json({ message: "This dashboard is restricted to same-origin localhost access." }, { status: 403, headers });
    }
    const path = (await context.params).path.join("/");
    if (!allowed.get(path)?.includes(request.method)) return Response.json({ message: "Unsupported operation." }, { status: 404, headers });
    const backend = new URL(process.env.RELAY_API_URL ?? "http://127.0.0.1:3000");
    if (!local(backend) || backend.protocol !== "http:" || backend.username || backend.password) {
      return Response.json({ message: "RELAY_API_URL must be an HTTP localhost address without credentials." }, { status: 503, headers });
    }
    const target = new URL(`/v1/${path}`, backend);
    target.search = request.nextUrl.search;
    const upstreamHeaders = new Headers({ "Content-Type": "application/json" });
    const key = request.headers.get("idempotency-key");
    if (key) upstreamHeaders.set("Idempotency-Key", key);
    const body = request.method === "GET" ? undefined : await request.text();
    if (body && new TextEncoder().encode(body).length > 65536) return Response.json({ message: "Request too large." }, { status: 413, headers });
    const result = await fetch(target, {
      method: request.method, headers: upstreamHeaders, body,
      cache: "no-store", signal: AbortSignal.timeout(15000), redirect: "error",
    });
    const data = await result.json();
    const responseHeaders = new Headers(headers);
    for (const name of ["Retry-After", "RateLimit-Limit", "RateLimit-Remaining", "RateLimit-Reset"]) {
      const value = result.headers.get(name); if (value) responseHeaders.set(name, value);
    }
    return Response.json(data, { status: result.status, headers: responseHeaders });
  } catch {
    return Response.json({ message: "Relay API is unreachable. Start the API with DASHBOARD_ENABLED=true and check its local port." }, { status: 503, headers });
  }
}
export { proxy as GET, proxy as POST, proxy as PUT };
