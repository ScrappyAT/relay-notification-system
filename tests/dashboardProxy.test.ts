import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "../apps/dashboard/node_modules/next/server.js";
import { GET, POST } from "../apps/dashboard/app/api/relay/[...path]/route.js";

function context(path: string) { return { params: Promise.resolve({ path: path.split("/") }) }; }
function request(path = "dashboard/customers", options?: RequestInit) {
  return new NextRequest(`http://127.0.0.1:3100/api/relay/${path}`, {
    ...options, headers: { host: "127.0.0.1:3100", ...options?.headers },
  });
}
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe("Dashboard server proxy", () => {
  it.each([
    { host: "public.example" }, { origin: "https://public.example" },
    { origin: "http://127.0.0.1:9000" }, { "sec-fetch-site": "cross-site" },
  ])("rejects nonlocal or cross-origin requests before fetching: %j", async (headers) => {
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    const response = await GET(request("dashboard/customers", { headers }), context("dashboard/customers"));
    expect(response.status).toBe(403); expect(fetch).not.toHaveBeenCalled();
  });
  it("does not provide an arbitrary upstream or metrics proxy", async () => {
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    const response = await GET(request("metrics"), context("metrics"));
    expect(response.status).toBe(404); expect(fetch).not.toHaveBeenCalled();
  });
  it.each(["https://127.0.0.1:3000", "http://remote.example", "http://user:secret@127.0.0.1:3000"])("rejects unsafe backend configuration %s", async (url) => {
    vi.stubEnv("RELAY_API_URL", url);
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    const response = await GET(request(), context("dashboard/customers"));
    expect(response.status).toBe(503); expect(fetch).not.toHaveBeenCalled();
    expect(JSON.stringify(await response.json())).not.toContain("secret");
  });
  it("preserves upstream status and rate-limit feedback with no caching", async () => {
    vi.stubEnv("RELAY_API_URL", "http://127.0.0.1:3200");
    const fetch = vi.fn().mockResolvedValue(Response.json({message:"Too many requests"}, {status:429,headers:{"Retry-After":"12"}}));
    vi.stubGlobal("fetch",fetch);
    const response = await POST(request("notifications", {method:"POST",body:'{"channel":"email"}',headers:{"idempotency-key":"stable-retry-key","content-type":"application/json"}}),context("notifications"));
    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("12");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const [url, options] = fetch.mock.calls[0];
    expect(url.toString()).toBe("http://127.0.0.1:3200/v1/notifications");
    expect(options.headers.get("Idempotency-Key")).toBe("stable-retry-key");
    expect(options.redirect).toBe("error");
    expect(options.cache).toBe("no-store");
  });
  it("turns upstream connection failures into a safe actionable error", async () => {
    vi.stubGlobal("fetch",vi.fn().mockRejectedValue(new Error("private failure details")));
    const response = await GET(request(),context("dashboard/customers"));
    expect(response.status).toBe(503);
    const body = await response.json();
    expect(body.message).toContain("Start the API");
    expect(body.message).not.toContain("private failure");
  });
});
