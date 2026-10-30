# Milestone 9 — verification and publication audit

Verified on 30 October 2026 for `ScrappyAT/relay-notification-system`.

## Repository and publication scope

- Published backend baseline: `b321da29a9bef323a5b8f3e09e3cbe01a4a84c70`.
- Existing dashboard implementation: `97bb341`, preserved without amendment or history rewriting.
- Publication branch: `feat/relay-admin-dashboard`, created from the dashboard branch. No pre-existing local or remote branch of that name was found.
- Required new commit message: `feat(dashboard): add Relay admin dashboard and local demo environment`.
- At initial inspection, the only uncommitted change was Next.js switching its generated `next-env.d.ts` imports to development paths. The production build regenerated its production imports; no user-authored work was discarded.
- Publication is source-code preservation on GitHub only. No public application deployment, merge, force-push, remote database change or demonstration-data deletion is authorized or performed.

The final commit identifier, push result and pull request URL are recorded in the publication handoff and GitHub pull request. Keeping these outside their own commit avoids a self-referential commit hash.

## Automated verification

| Check | Result |
| --- | --- |
| `npm.cmd test -- --reporter=json --outputFile=.local/milestone9-tests.json` | **125 passed, 0 failed, 0 skipped; 14 files** |
| Original backend tests | **95 passed; original files unchanged** |
| Additional dashboard tests | 15 access/validation tests, 5 PostgreSQL integration tests, 10 proxy tests passed |
| `npm.cmd run build` | Passed |
| `npm.cmd run build --prefix apps/dashboard` | Passed; optimized Next.js production build, static dashboard and dynamic proxy |
| `npm.cmd run typecheck --prefix apps/dashboard` | Passed |
| Dashboard lint | No lint script/configuration is present; no lint result claimed |
| `npm.cmd run demo:setup` | Passed; preserved existing ignored configuration; no database changes |
| Whitespace checks | `git diff --check` and staged `git diff --cached --check` required clean before publication |

Tests ran with explicit localhost `DATABASE_URL` and `REDIS_URL` overrides against a new `relay-verification` compose project on ports **5546/6392**. This project has a separate PostgreSQL volume and Redis instance. The existing manual demo on **5544/6390**, its volume, and the root `.env` were not modified. The test password and results are under ignored `.local/`. No test used the remote database.

## Backend baseline comparison

Compared against `b321da2`, the following remain byte-for-byte unchanged:

- Migrations **001–006**, database pool, and schema initialization SQL.
- Notification and preference routes, validation, repositories and ingestion transaction.
- Transactional outbox claiming/publication logic and idempotency.
- Email/SMS workers, retry/backoff configuration and provider adapter.
- Redis/BullMQ integration, fairness, backpressure and reconciliation services.
- All 11 original test files and original test configuration.

The backend integration changes register the dashboard router, add explicit dashboard/demo settings and localhost request checks, and disable cross-origin CORS grants. Following PR #1 review, API/daemon metrics listeners are forced to loopback only when dashboard or demo mode is enabled; non-demo bindings are independently configurable with `API_HOST`/`METRICS_HOST` and otherwise retain the original Node defaults. The new router adds only GET endpoints: `/v1/dashboard/customers`, `/overview`, `/notifications`, `/preferences`, and `/monitoring`. Its PostgreSQL queries are SELECT-only and parameterized. Queue monitoring reads BullMQ counts; no queue-control or failure-control administrative endpoint was added.

## Features and manual evidence

### PR #1 listener-binding review follow-up

The original dashboard commit hardcoded `127.0.0.1` into API and process-metrics startup for every environment. Baseline `b321da2` omitted the host and therefore supported Node's normal unspecified-interface binding. The unconditional change could prevent non-demo container ingress or external metrics scraping.

The fix adds independent optional `API_HOST` and `METRICS_HOST` configuration. Outside dashboard/demo mode, an unset host is omitted from `listen()` options to preserve the exact original IPv6/IPv4 default behavior. Either `DEMO_MODE=true` or `DASHBOARD_ENABLED=true` forces **both** listeners to `127.0.0.1`, overriding wildcard host settings. The isolated demo launcher explicitly sets demo mode and loopback hosts even for test runs with dashboard reads disabled. Next.js and Docker demo bindings, disabled-by-default dashboard reads, and all existing local-access middleware are unchanged.

API startup is exposed through a small `startApiServer` factory so tests can inspect real bound sockets without importing the CLI's signal handlers. Notification processing and shutdown behavior are unchanged.

Follow-up verification: **140/140 tests passed, 0 failed/skipped across 15 files**, including **95/95 original backend tests** and **15 new binding tests**. The new tests cover parsed defaults in development/test/production, independent hosts, empty-host rejection, strict boolean flags, real API/metrics socket addresses, loopback enforcement despite IPv4/IPv6 wildcard overrides, and disabled/protected dashboard endpoints. Backend build, dashboard production build, dashboard TypeScript check and whitespace checks passed. Tests used only the separate local verification services; no remote database or existing demonstration data was modified.

Overview, Send Notification, Notifications, Preferences, Monitoring and Failure Simulator use live backend data. Loading, errors and empty states are implemented. Provider acceptance and confirmed delivery remain distinct.

The user reported successful manual verification of live overview data, email/SMS `provider_accepted`, accurate history, preference editing and suppression, healthy API/PostgreSQL/Redis monitoring, and persistent HTTP 503 retry exhaustion. Previous implementation browser checks also covered the 429, timeout, permanent rejection and success-control scenarios, filtering, search and responsive layouts. These are reported as manual/browser evidence, not additional automated test cases.

The configured retry budget is **5 total attempts**, not five retries after the initial attempt. The persistent 503/429 conventions terminate as failed after that budget. Timeout outcomes stop blind retries.

Existing screenshots are included as [desktop overview](docs/screenshots/overview-desktop.jpg) and [mobile overview](docs/screenshots/overview-mobile.jpg). They display local test aggregates, without credentials or generated tenant UUIDs.

## Security and file audit

- Tracked-file checks excluded real environment files, `node_modules`, `.next`, `dist`, local persistence, logs, generated tenant manifests and executables. `.gitignore` explicitly covers these categories.
- `apps/dashboard/.env.example` contains only a server-side localhost upstream example; it has no database URL, password, token or browser-exposed secret.
- Current demo source has no embedded database password. `.env.demo.example` contains a placeholder; setup writes a random value to ignored `.env.demo` for new installations.
- Existing local configuration was preserved in the ignored file to match the existing volume. The setup helper refuses to invent replacement credentials when it detects an existing volume without configuration.
- Changed-file scans found no private-key blocks, GitHub access tokens or AWS access-key patterns. Manual review distinguished explicit synthetic negative-test strings from actual secrets. This is a scoped source audit, not a claim of a comprehensive security assessment.
- The frontend uses a server-only localhost proxy with an operation allowlist, origin checks, no-store responses, redirect rejection and timeouts. Database credentials are absent from frontend code and browser environment variables.
- Demo Docker ports, the dashboard frontend, and API/metrics listeners with dashboard or demo mode enabled remain loopback-only. Non-demo backend listeners retain their original defaults with optional independent host configuration. No hosting, tunnel, public deployment or CI deployment configuration was introduced.
- **History limitation:** the preserved original dashboard commit contains disposable localhost demo defaults. These were never production secrets. History is not rewritten; the current tree externalizes the password and new installations generate a random value.
- **Authentication limitation:** no tenant authentication or authorization exists. Keep the dashboard and all administrative endpoints local; localhost checks do not make it production-ready.
- Provider acceptance does not confirm recipient delivery; worker liveness remains uninstrumented. Queue/outbox monitoring is global and API counters are process-local.

## Run locally

```sh
npm ci
npm ci --prefix apps/dashboard
npm run demo:setup
docker compose --env-file .env.demo -f compose.dashboard.yml up -d --wait
npm run demo:tenant
```

Then use separate terminals for `npm run demo:api`, `npm run demo:dispatcher`, `npm run demo:workers`, `npm run demo:reconcile`, and `npm run demo:dashboard`. Open `http://127.0.0.1:3100`. Full behavior and troubleshooting are in [DASHBOARD.md](DASHBOARD.md).

The verification containers are stopped after checks without deleting their volumes. Existing demo containers and data are left intact.

## File inventory relative to the published baseline

The inventory below records the complete publication scope; the new publication commit contains only the configuration-hardening and documentation follow-up on top of the preserved dashboard commit.

| Status | File |
| --- | --- |
| A | `.env.demo.example` |
| A | `apps/dashboard/.env.example` |
| A | `apps/dashboard/AGENTS.md` |
| A | `apps/dashboard/app/api/relay/[...path]/route.ts` |
| A | `apps/dashboard/app/globals.css` |
| A | `apps/dashboard/app/layout.tsx` |
| A | `apps/dashboard/app/page.tsx` |
| A | `apps/dashboard/components/monitoring.tsx` |
| A | `apps/dashboard/components/notifications.tsx` |
| A | `apps/dashboard/components/overview.tsx` |
| A | `apps/dashboard/components/preferences.tsx` |
| A | `apps/dashboard/components/send.tsx` |
| A | `apps/dashboard/components/ui.tsx` |
| A | `apps/dashboard/lib/api.ts` |
| A | `apps/dashboard/lib/types.ts` |
| A | `apps/dashboard/next-env.d.ts` |
| A | `apps/dashboard/next.config.ts` |
| A | `apps/dashboard/package-lock.json` |
| A | `apps/dashboard/package.json` |
| A | `apps/dashboard/postcss.config.mjs` |
| A | `apps/dashboard/tsconfig.json` |
| A | `compose.dashboard.yml` |
| A | `DASHBOARD.md` |
| A | `docs/screenshots/overview-desktop.jpg` |
| A | `docs/screenshots/overview-mobile.jpg` |
| A | `MILESTONE-9-PUBLICATION.md` |
| A | `scripts/dashboardTenant.ts` |
| A | `scripts/localDemo.ts` |
| A | `scripts/setupLocalDemo.ts` |
| A | `src/middleware/localOnly.ts` |
| A | `src/apiServer.ts` |
| A | `src/config/listen.ts` |
| A | `src/routes/dashboard.ts` |
| A | `tests/dashboard.integration.test.ts` |
| A | `tests/dashboard.test.ts` |
| A | `tests/dashboardProxy.test.ts` |
| A | `tests/serverBindings.test.ts` |
| M | `.env.example` |
| M | `.gitignore` |
| M | `package.json` |
| M | `README.md` |
| M | `src/app.ts` |
| M | `src/config/env.ts` |
| M | `src/metrics/server.ts` |
| M | `src/server.ts` |
