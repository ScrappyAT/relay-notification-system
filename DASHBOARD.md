# Relay local dashboard

A Next.js App Router, TypeScript, React and Tailwind CSS frontend lives in `apps/dashboard`. It is a **localhost-only demonstration**. Tenant identity is selected by the operator; Relay has no tenant authentication. Do not deploy it, expose it through a tunnel, or put a public reverse proxy in front of it.

## Recommended: isolated local environment

Prerequisites: Node.js 22.13+ (verified with Node 24), npm, Docker Desktop with Linux containers. Run commands from the repository root. These commands leave the existing `.env`, remote database and existing Redis queues untouched.

```sh
npm ci
npm ci --prefix apps/dashboard
npm run demo:setup
docker compose --env-file .env.demo -f compose.dashboard.yml up -d --wait
npm run demo:tenant
```

The compose project creates PostgreSQL 16 on **127.0.0.1:5544** and Redis 7 on **127.0.0.1:6390**. PostgreSQL initializes a fresh volume with the six existing migrations in order. Historical migrations are unchanged. The database/user are `relay_demo`; `demo:setup` generates a random password in ignored `.env.demo`. No password belongs in tracked source or frontend settings. `.env.demo.example` contains a placeholder only.

Existing installations: preserve `.env.demo` and the database volume. If a volume already exists without that file, setup stops; supply its existing password in ignored `.env.demo`. The helper never resets the database, rotates existing credentials, or deletes demonstration data. The prior implementation's disposable localhost password has been preserved in the ignored local file for this checkout.

Open a separate terminal for each process:

```sh
# Terminal 1: Express API on http://127.0.0.1:3200
npm run demo:api

# Terminal 2: transactional outbox dispatcher
npm run demo:dispatcher

# Terminal 3: email and SMS BullMQ workers
npm run demo:workers

# Terminal 4: expired worker lease reconciliation
npm run demo:reconcile

# Terminal 5: Next.js dashboard on http://127.0.0.1:3100
npm run demo:dashboard
```

Open **http://127.0.0.1:3100**, select **Relay demo workspace**, and send a test email or SMS. The tenant helper creates only a customer; notification statistics start empty and are computed from real submitted records. The simulator is local and does not contact SendGrid or Twilio.

The `demo:*` scripts read ignored `.env.demo` and supply the same local database, Redis and API configuration to every process. They explicitly set `DEMO_MODE=true` and loopback API/metrics hosts, including for demo tests where dashboard reads are disabled. The tenant helper rejects remote PostgreSQL hosts. Demo API and daemon metrics servers bind to `127.0.0.1`, and the dashboard scripts explicitly bind Next.js to `127.0.0.1`.

Stop processes with Ctrl+C in their terminals. Stop the isolated infrastructure while preserving data with:

```sh
docker compose --env-file .env.demo -f compose.dashboard.yml down
```

The named PostgreSQL volume persists. Initialization runs only on the first use of a fresh volume. Do not rerun historical migrations against an existing initialized database. The existing `npm run migrate` script applies only migration 006; it is not a fresh-database initializer.

## Use an already configured backend

Your existing database must already have migrations 001–006 applied. Keep `DATABASE_URL` and `REDIS_URL` in the root `.env`; never copy these into frontend settings. Add `DASHBOARD_ENABLED=true` to the root `.env`. Restart the API using `npm run dev`, then run `npm run dispatcher`, `npm run workers`, and `npm run reconcile` in separate terminals.

The existing API defaults to port 3000. `npm run dashboard` starts the frontend on port 3100 and proxies to `http://127.0.0.1:3000`. For another API port, copy `apps/dashboard/.env.example` to `apps/dashboard/.env.local` and change **only** `RELAY_API_URL` to an HTTP localhost address. This is a server-only variable; there are no `NEXT_PUBLIC_*` credentials. When using the isolated `demo:dashboard` script, its explicit environment takes precedence over this file.

### Backend listener configuration outside the demo

`API_HOST` and `METRICS_HOST` independently configure the Express API and all daemon metrics listeners. When both `DEMO_MODE=false` and `DASHBOARD_ENABLED=false` (the defaults), omitting a host preserves the original Node unspecified-interface behavior (`::` where available, otherwise `0.0.0.0`). `NODE_ENV` does not implicitly enable demo mode.

| Mode | API binding | Daemon metrics binding |
| --- | --- | --- |
| Non-demo, no host settings | Original Node default | Original Node default |
| Non-demo, host settings supplied | `API_HOST` | `METRICS_HOST` |
| `DEMO_MODE=true` or `DASHBOARD_ENABLED=true` | Forced `127.0.0.1` | Forced `127.0.0.1` |

For example, a non-demo container can use `API_HOST=0.0.0.0` while keeping `METRICS_HOST=127.0.0.1`, or supply a separate metrics interface for its scraper. Configure firewall/access controls for non-demo metrics as in the original backend. Dashboard reads remain disabled by default; enabling the dashboard forces both backend listener types to loopback regardless of host overrides. The existing dashboard Host/origin/socket guards and frontend localhost binding remain in place.

## Views and data definitions

| View | Behavior |
| --- | --- |
| Overview | PostgreSQL request totals, provider acceptance, in-flight and failed counts; zero-filled daily UTC email/SMS chart; channel mix; recent records; dependency status. Range: today, 7 or 30 calendar days. |
| Send notification | Email or SMS through the existing POST API, payload validation, idempotency, rate-limit and overload feedback, suppression awareness. The same key is reused after an uncertain/error response when the request is unchanged; a successful next send gets a new key. |
| Notifications | Tenant, literal recipient/ID search, channel, lifecycle status, pagination, retry counts, timestamps, copy-ID control. History includes all time, independent of the overview range. |
| Preferences | Tenant-scoped saved preferences with search/pagination, exact-recipient lookup including default-allow, and existing PUT API updates. Click a saved preference to edit it. |
| Monitoring | API/database/Redis health, live queue counts, durable outbox backlog/age/failures, API-process uptime/request/error counters, connection-pool state and Redis reconnections. |
| Failure simulator | Email submissions using the adapter's existing `sim-503`, `sim-429`, `sim-timeout`, `sim-400` recipient conventions, plus a success control. |

Provider acceptance percentage is `(provider_accepted + delivered) / (total - suppressed)` for the selected creation-date range; it is not a confirmed delivery rate. `processed`, `provider_accepted` and `delivered` remain distinct statuses. The database cannot confirm external delivery without receipts. Unknown outcomes and suppressed requests are shown separately.

Overview and history poll every 15 seconds; monitoring polls every 10 seconds. Failed refreshes display an error and retain the last successful snapshot. Tenant/filter changes clear stale data. Global queue/outbox metrics are explicitly labeled; tenant selection does not filter shared queues. API counters are process-local and reset on restart. Completed/failed BullMQ counts reflect retained jobs, not historical totals. Worker liveness is not inferred from an empty queue and is reported as uninstrumented.

### Failure simulator expectations

| Scenario | Recipient | Expected lifecycle |
| --- | --- | --- |
| Persistent service outage | `relay-sim-503@example.com` | processing with retries → failed after 5 attempts |
| Persistent rate limiting | `relay-sim-429@example.com` | processing with retries → failed after 5 attempts |
| Network timeout | `relay-sim-timeout@example.com` | outcome_unknown; no blind retry |
| Permanent rejection | `relay-sim-400@example.com` | failed immediately |
| Success control | `relay-control@example.com` | provider_accepted |

503/429 patterns persist on every attempt (roughly 30 seconds of configured backoff). They do not demonstrate one-failure recovery; that remains covered by the existing in-process adapter tests. Preference suppression applies to scenario recipients too. The UI uses email conventions that the adapter already supports; ordinary SMS testing is available in Send notification. No mutable failure-control API or cross-process override mechanism was introduced.

## API additions and architecture

The Express API adds five **read-only** routes under `/v1/dashboard`: `/customers`, `/overview`, `/notifications`, `/preferences`, `/monitoring`. They are disabled by default (`DASHBOARD_ENABLED=false`), and when enabled require a direct loopback connection, a localhost Host and no cross-site origin. Demo mode also applies these guards to the existing API routes. CORS grants no cross-origin browser access. The API does not trust forwarded headers.

The frontend's `/api/relay/[...path]` route permits only these reads, notification POST, and preference GET/PUT. It enforces a local Host and same-origin browser requests, restricts the server's upstream to HTTP localhost, blocks redirects, uses no-store responses, sets a request timeout, and relays only relevant rate-limit headers. It does not expose raw Prometheus endpoints, database credentials, connection strings, payloads, worker control or arbitrary upstream URLs. Do not override the loopback binding for this demonstration.

Dashboard SQL uses parameterized filters, query timeouts, bounded page sizes and deterministic ordering. Daily activity uses UTC calendar days on the isolated database. No historical migration, queue algorithm, ingestion transaction, idempotency implementation, worker lease, fairness, backpressure, reconciliation or provider adapter was changed. Additional tenant listings are capped at 1,000 customers for this local demonstration.

## Verification

Run the entire existing integration suite and the added dashboard boundary/query tests with isolated infrastructure running. **Stop the demo dispatcher/workers/reconciler first** so they cannot compete with test workers for jobs. Use the isolated database only for disposable test/demo data. Existing tests can inspect or act on global pending notifications.

```sh
npm run demo:test
npm run build
npm run dashboard:build
npm --prefix apps/dashboard run typecheck
```

`npm test` retains its original behavior and uses the configured database and Redis. Set `DATABASE_URL` and `REDIS_URL` explicitly to disposable local test services before running it; do not point it at a remote database or a demonstration database whose contents must be preserved. Existing tests have not been changed or removed. Milestone 9 verification uses a separate compose project/volume and ports 5546/6392, without changing the existing demo services or data.

Production-build local preview (after `npm run dashboard:build`):

```sh
# Set RELAY_API_URL=http://127.0.0.1:3200 in the shell or apps/dashboard/.env.local
# when using the isolated API; the default is http://127.0.0.1:3000.
npm --prefix apps/dashboard start
```

## Verification record — 30 October 2026

- Full isolated suite: **125 / 125 tests passing**, across 14 files. Includes all **95 existing tests unchanged**, 15 local-access/validation tests, 5 PostgreSQL dashboard integration tests, and 10 server-proxy tests.
- Backend TypeScript build: passed. Next.js optimized production build and frontend TypeScript check: passed.
- Browser checks: real email/SMS submissions reached `provider_accepted`; an email opt-out produced `suppressed`; all five failure simulator scenarios were submitted through the existing API, dispatcher and workers. 503/429 reached `failed` after retries, 400 failed immediately, timeout reached `outcome_unknown`, and the control request reached `provider_accepted`.
- Verified history channel filtering, literal search, empty results, preference default-allow lookup, preference editing, and live monitoring. Desktop (1440px) and mobile (390px) layouts were checked; a table accessibility-label overflow found on mobile was fixed. No document-level horizontal overflow remained.
- Screenshots: [Desktop overview](docs/screenshots/overview-desktop.jpg), [mobile overview](docs/screenshots/overview-mobile.jpg). These show real local test requests, not seeded aggregate statistics.
- The initial run against the pre-existing remote database/shared Redis completed with 83 passed, 8 failed and 4 skipped, with connection resets and stale queue jobs. The isolated run above passed fully. No existing tests were weakened to obtain a passing result.
- No deployment, merge or historical migration modification was performed.

## Troubleshooting

- **API unreachable:** check the API port and `RELAY_API_URL`, and restart with `DASHBOARD_ENABLED=true`. The API logs the selected port.
- **404 on dashboard reads:** admin reads are disabled in that API process. Restart after enabling the setting.
- **No tenants:** run `npm run demo:tenant` for the isolated stack; for an existing backend, select/create a valid customer using your established setup.
- **Pending notifications:** run the dispatcher and workers with the exact same database and Redis configuration as the API.
- **Unavailable queues:** start Redis; unavailable counts are displayed as unavailable, never fabricated zeros.
- **Suppressed scenario:** enable that exact email recipient under the selected tenant before submitting a new request.
- **Build permission errors:** Next.js launches compiler subprocesses and uses local IPC. It needs normal local process/network permissions on Windows.

## Publication and remaining security limits

The dashboard is unauthenticated and has no tenant authorization; tenant selection is an operator convenience. The localhost checks are a demonstration boundary, not a production authentication mechanism. Do not tunnel or publicly proxy the services. Provider acceptance is not a delivery receipt, and worker liveness is not fully instrumented.

Only example environment files are tracked. Actual `.env`, `.env.demo`, frontend `.env.local`, generated files, local persistence, logs and verification reports are ignored. The original dashboard commit used disposable localhost-only demonstration defaults; that commit is preserved, as requested, without rewriting history. These were never production credentials. Current source reads the password from the ignored file and new installations generate a random value.

See [MILESTONE-9-PUBLICATION.md](MILESTONE-9-PUBLICATION.md) for the final baseline comparison, test results and publication audit.
