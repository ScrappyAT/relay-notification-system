# Relay

## Local admin dashboard

The Next.js, TypeScript and Tailwind CSS dashboard in `apps/dashboard` includes Overview, Send Notification, Notifications, Preferences, Monitoring and Failure Simulator. It uses the real Relay API and database. See **[DASHBOARD.md](DASHBOARD.md)** for the isolated localhost setup, startup commands, data definitions, security boundaries and verification. No tenant authentication is implemented; keep this demonstration on localhost.

Multi-tenant notification infrastructure prototype designed around high-reliability distributed systems principles.

**Current status:** Milestones 1–7D fully implemented and verified. Ingestion API with PostgreSQL transactional outbox, BullMQ workers, lease reconciliation, tenant rate limiting, dual-stage tenant fairness, admission backpressure, recipient notification preferences, simulated provider failures, k6 load testing, cited infrastructure cost modeling, and comprehensive Prometheus observability. 95 automated tests passing across 11 test files.

- **[SUBMISSION.md](file:///c:/Users/HP/Desktop/relay-system/SUBMISSION.md)**: Complete graduation submission document covering architecture, reliability claims, evidence, trade-offs, and reproduction.
- **[DEMO-GUIDE.md](file:///c:/Users/HP/Desktop/relay-system/DEMO-GUIDE.md)**: 10-minute live presentation guide with pre-demo checklist, verbatim commands, and fallback procedures.
- **[INTERVIEW-PREP.md](file:///c:/Users/HP/Desktop/relay-system/INTERVIEW-PREP.md)**: 15 challenging technical interview questions with architectural defenses.
- **[DESIGN.md](file:///c:/Users/HP/Desktop/relay-system/DESIGN.md)**: Complete technical specification and architecture document.
- **[LEARNING-LOG.md](file:///c:/Users/HP/Desktop/relay-system/LEARNING-LOG.md)**: Engineering decisions, empirical benchmark evidence, failure drills, and lessons learned.

**Implemented stack:** TypeScript, Node.js, Express 5, PostgreSQL 16 (Neon / PgBouncer), Redis 7 / BullMQ, Zod, prom-client, Vitest.
**Database migrations ([`src/database/migrations/`](file:///c:/Users/HP/Desktop/relay-system/src/database/migrations)):** `001_initial.sql`, `002_outbox_improvements.sql`, `003_worker_leases.sql`, `004_outbox_failure_handling.sql`, `005_notification_lifecycle.sql`, `006_notification_preferences.sql`.

---

## Operational Drills & Failure Testing

### Redis Outage and Recovery Drill Guide

This guide provides reproducible step-by-step instructions for executing the Redis Outage and Recovery Drill originally validated on October 28, 2026. The drill verifies that Relay's Transactional Outbox pattern preserves ingress availability and durability when Redis is completely unavailable.

#### Objective
Verify that:
1. The Relay API accepts notifications and responds with `202 Accepted` during a total Redis outage.
2. Accepted records and outbox events are durably persisted in PostgreSQL.
3. The Outbox Dispatcher traps Redis connection errors (`ECONNREFUSED`) gracefully without crashing.
4. When Redis is restored, the Outbox Dispatcher automatically reconnects, claims backlogged outbox events, and enqueues them to BullMQ.
5. Workers consume the queued jobs and complete the notification lifecycle to `processed` without message loss or duplicate sends.

---

### Drill Procedure

#### Step 1: Start Core Infrastructure & Services
Ensure PostgreSQL and Redis are running. In separate terminal windows (or background jobs), start the application components:

```bash
# Terminal 1: Start the Relay API Server
npm run dev
# Or: npx tsx src/server.ts

# Terminal 2: Start the Outbox Dispatcher Daemon
npm run dispatcher
# Or: npx tsx src/dispatcher.ts

# Terminal 3: Start the Queue Workers (SMS & Email)
npm run workers
# Or: npx tsx src/workers.ts
```

Verify baseline health:
```bash
curl -i http://localhost:3000/v1/health
```

#### Step 2: Inject Redis Failure
Simulate a complete Redis failure. You can stop the Redis service, stop its Docker container, or reconfigure the connection to an unreachable port (such as port `6386`, as occurred in the October 28 drill):

```bash
# If using Docker:
docker stop relay-redis

# Or if running locally via service / CLI:
# Stop redis-server, or point REDIS_URL=redis://localhost:6386 in .env
```

#### Step 3: Ingest Notification Under Outage Conditions
With Redis offline, send a notification request via the API:

```bash
curl -i -X POST http://localhost:3000/v1/notifications \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: drill-test-key-001" \
  -d '{
    "customerId": "<VALID_CUSTOMER_UUID>",
    "recipient": "+15555550199",
    "channel": "sms",
    "payload": {
      "body": "Resilience drill notification under Redis outage"
    }
  }'
```

**Expected Response:**
- HTTP status `202 Accepted`
- Response body returns notification payload with `status: "pending"` and a generated `id` (e.g. `16abf08c-837b-4b50-86ae-c327e7795f5d`).

#### Step 4: Mid-Outage Verification & Observations
Check the dispatcher logs:
- The Outbox Dispatcher logs connection errors (e.g. `Redis connection error: connect ECONNREFUSED 127.0.0.1:6386`).
- The dispatcher does not crash; it traps the queue addition failure, releases the claimed row lock (`releaseClaim`), and prepares for retry.

> [!IMPORTANT]
> **Operator Note (Mid-Outage Database Snapshot):**
> In the October 28 baseline test, no database snapshot was captured while Redis was unavailable; therefore the intermediate pending/unpublished state was not independently sampled during that specific run.
> When repeating this drill, capture an explicit database snapshot at this point to independently verify the intermediate state:
> ```sql
> -- Run in PostgreSQL while Redis is offline:
> SELECT id, status, updated_at FROM notifications WHERE id = '<NOTIFICATION_ID>';
> -- Expected: status = 'pending'
>
> SELECT id, notification_id, published_at, attempts, locked_until, failed_at
> FROM outbox_events WHERE notification_id = '<NOTIFICATION_ID>';
> -- Expected: published_at IS NULL, failed_at IS NULL
> ```

#### Step 5: Restore Redis Service
Restore Redis connectivity by restarting the container or restoring the original service port:

```bash
# If using Docker:
docker start relay-redis

# Or restart redis-server on port 6379
```

#### Step 6: Verify Recovery & Processing
Observe the logs across services:
1. **Dispatcher Terminal:**
   - Logs `Redis connected` as `ioredis` automatically re-establishes connectivity.
   - On the subsequent poll cycle (default 1000ms), claims the unpublished event and logs:
     `Published outbox event <EVENT_ID> for notification <NOTIFICATION_ID> to sms queue`
2. **Worker Terminal:**
   - Worker picks up the job (`Processing SMS job notif-<NOTIFICATION_ID> for notification <NOTIFICATION_ID>`).
   - Acquires the atomic lease in PostgreSQL and executes simulation.
   - Updates status and logs: `SMS job notif-<NOTIFICATION_ID> completed`.

#### Step 7: Verify Final Database State
Execute the post-recovery verification query:

```sql
-- 1. Check notification lifecycle state:
SELECT id, customer_id, channel, status, created_at, updated_at
FROM notifications
WHERE id = '<NOTIFICATION_ID>';
-- Expected: status = 'processed'

-- 2. Check outbox event publication:
SELECT id, notification_id, event_type, published_at, attempts, locked_until, failed_at, failure_reason
FROM outbox_events
WHERE notification_id = '<NOTIFICATION_ID>';
-- Expected:
--   published_at IS NOT NULL
--   attempts >= 1
--   locked_until IS NULL
--   failed_at IS NULL
--   failure_reason IS NULL
```

---

### Reference Drill Results (October 28, 2026 Test Run)
- **Notification ID:** `16abf08c-837b-4b50-86ae-c327e7795f5d`
- **Channel:** `SMS`
- **Created Timestamp:** `11:07:05 UTC`
- **Published Timestamp:** `11:08:01 UTC`
- **Elapsed Recovery Time:** `~55.4 seconds`
- **Observed Diagnostics:** Redis failure (`ECONNREFUSED` on port 6386) → automatic reconnection → outbox event dispatched with deterministic job ID (`notif-16abf08c-837b-4b50-86ae-c327e7795f5d`) → final status `processed`. In this test run, zero message loss and zero duplicate sends were observed.

---

## Milestone 6A: Observability & Operational Metrics

Relay provides Prometheus-compatible operational telemetry using `prom-client` across all system components.

### 1. Endpoints Overview

| Method | Endpoint | Purpose | Description |
| :--- | :--- | :--- | :--- |
| `GET` | `/v1/health` | Liveness | Instant process heartbeat returning HTTP 200 `{ status: "ok" }`. |
| `GET` | `/v1/ready` | Readiness | Evaluates durable acceptance dependency (PostgreSQL). Returns HTTP 200 when DB is up (even if Redis is down). Returns HTTP 503 if DB is down. |
| `GET` | `/metrics` | Prometheus Metrics | Exposes operational counters, gauges, and histograms in standard Prometheus exposition text format. |

### 2. Available Metrics Catalogue

- **API Ingress Telemetry:**
  - `relay_api_requests_total{method, route, status_code}`: Total HTTP requests.
  - `relay_api_request_duration_seconds{method, route, status_code}`: Request latency histogram (5ms to 10s).
  - `relay_api_validation_failures_total`: Total 400 validation rejections.
  - `relay_api_idempotency_conflicts_total`: Total 409 idempotency payload conflicts.
  - `relay_api_rate_limits_total`: Total 429 rate limit events.
- **Notification Lifecycle Telemetry:**
  - `relay_notifications_status_total{status, channel}`: Tracks transitions (`accepted`, `queued`, `processing`, `processed`, `failed`, `outcome_unknown`).
- **Outbox Dispatcher Telemetry:**
  - `relay_dispatcher_outbox_awaiting_publication`: Gauge of unpublished events in PostgreSQL.
  - `relay_dispatcher_publications_total{channel, status}`: Publication attempts (`success`, `failure`).
  - `relay_dispatcher_publication_duration_seconds{channel}`: Outbox-to-queue publication latency.
  - `relay_dispatcher_outbox_retries_total{channel}`: Re-claimed outbox events.
- **Worker & Queue Telemetry:**
  - `relay_worker_jobs_total{channel, status}`: Worker execution outcomes (`processed`, `failed`, `skipped`).
  - `relay_worker_job_duration_seconds{channel}`: Worker execution duration histogram.
  - `relay_worker_retries_total{channel}`: Worker job retry attempts.
  - `relay_worker_active_jobs{channel}`: Concurrently active worker jobs.
  - `relay_queue_jobs_waiting{channel}` / `active` / `delayed` / `failed` / `completed`: BullMQ queue gauges.
- **Worker Reconciliation Telemetry:**
  - `relay_reconciliation_expired_leases_total{channel}`: Stuck processing leases detected.
  - `relay_reconciliation_recovered_total{channel}`: Stuck notifications recovered/unlocked.
  - `relay_reconciliation_failures_total{channel}`: Reconciliation processing errors.
- **Redis Reconnection Telemetry:**
  - `relay_redis_connected`: Gauge (1 = connected, 0 = disconnected).
  - `relay_redis_disconnects_total`: Counter for connection drops.
  - `relay_redis_reconnects_total`: Counter for successful reconnections.
  - `relay_redis_connection_errors_total`: Counter for connection error events.
  - `relay_redis_consecutive_failures`: Gauge for active consecutive errors.

### 3. Metric Label Safety
Metric labels are strictly bounded to prevent Prometheus cardinality explosion:
- Route paths are normalized (e.g. `/v1/notifications/:id`) via `normalizeRoute()`.
- Dynamic UUIDs (notification IDs, customer IDs), recipient emails, phone numbers, idempotency keys, and tenant identifiers are **never** used as Prometheus metric labels.

### 4. Metrics Across Separate Processes
Relay runs the API, outbox dispatcher, workers, and reconciliation service as independent Node.js processes.
- **Per-Process Metrics Servers:** Background daemons support optional dedicated HTTP metrics endpoints:
  - `DISPATCHER_METRICS_PORT` (e.g. `3001`)
  - `WORKERS_METRICS_PORT` (e.g. `3002`)
  - `RECONCILIATION_METRICS_PORT` (e.g. `3003`)
- **API Dynamic System Gauges:** When scraping the primary API on port `3000` (`GET /metrics`), the endpoint dynamically samples the PostgreSQL outbox backlog gauge and BullMQ queue gauges on scrape.

### 5. Manual Verification Commands

```bash
# 1. Check Liveness:
curl -i http://localhost:3000/v1/health

# 2. Check Readiness (PostgreSQL durable ingestion):
curl -i http://localhost:3000/v1/ready

# 3. Scrape Prometheus Metrics:
curl -s http://localhost:3000/metrics

# 4. Filter for Relay Metrics:
curl -s http://localhost:3000/metrics | grep "relay_"
```

### 6. Production Security for /metrics
The `/metrics` endpoint exposes internal performance metadata and should not be publicly accessible in production:
1. **Network Firewalls / VPC:** Restrict access to internal monitoring subnets only.
2. **Reverse Proxy Rules:** Block public requests to `/metrics` via NGINX/Caddy/Cloudflare.
3. **Authentication:** Enforce mTLS or internal reverse-proxy authentication headers before reaching the metrics route.

### 7. Capacity Context & Limitations
- **Target Workload Context:** Relay is designed around a target workload of 50 million notifications per day (~579/s average, ~5,787/s peak). The metrics framework provides the exact latency histograms, queue gauges, and error counters needed to detect bottlenecks under that volume.
- **Prototype Clarification:** The prototype implements and validates the observability architecture; it does **not** claim to have demonstrated 50M/day throughput in this prototype environment.

---

## Milestone 6B: Tenant-Level Rate Limiting

Relay implements atomic, Redis-backed sliding window rate limiting on `POST /v1/notifications` to prevent tenant saturation and noisy-neighbor starvation while preserving durable acceptance.

### 1. Configuration (`.env`)

| Variable | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `RATE_LIMIT_ENABLED` | boolean | `true` | Enables or disables rate limiting globally. |
| `RATE_LIMIT_WINDOW_SECONDS` | integer | `60` | Sliding window duration in seconds. |
| `RATE_LIMIT_MAX_REQUESTS` | integer | `100` | Maximum requests permitted per tenant per window. |
| `RATE_LIMIT_TIMEOUT_MS` | integer | `500` | Maximum duration before failing open on slow/hung Redis calls. |

### 2. Standard HTTP Response Headers

Every notification submission response includes standard `RateLimit-*` headers:

| Header | Example | Description |
| :--- | :--- | :--- |
| `RateLimit-Limit` | `100` | Maximum requests allowed within the sliding window. |
| `RateLimit-Remaining` | `99` | Remaining quota in the active sliding window. |
| `RateLimit-Reset` | `60` | Seconds until quota completely refreshes or oldest request rolls off. |
| `Retry-After` | `45` | *(Only on HTTP 429)* Seconds the client must wait before retrying. |

When a tenant exceeds their limit, Relay returns `HTTP 429 Too Many Requests`:
```json
{
  "code": "RATE_LIMIT_EXCEEDED",
  "message": "Too many requests for tenant d600ffb8-91ac-46ec-8837-c8455c9ffe5b. Please retry after 45 seconds."
}
```

### 3. Key Architectural Features

- **Atomic Sliding Window via Lua:** Employs Redis Sorted Sets (`rl:tenant:{customerId}`) with millisecond timestamps to eliminate the $2 \times \text{limit}$ boundary burst vulnerability of fixed-window counters.
- **Tenant Isolation:** Enforced strictly per-tenant (`customerId`). Saturation by Tenant A has zero effect on Tenant B.
- **Idempotency Refund Policy:** Quota is consumed before database execution to protect PostgreSQL from replay DDoS attacks. Safe identical replays (HTTP 202) automatically refund the consumed token via `ZREM`. Conflicting replays (HTTP 409) do not receive refunds.
- **Fail-Open Resilience:** If Redis is down or times out (>500ms), Relay automatically fails open (`failOpen: true`) to preserve durable acceptance of notifications into PostgreSQL. Warnings are throttled to at most once per 30 seconds.
- **Prometheus Metrics:** Tracks `relay_rate_limit_evaluations_total{result="allowed|rate_limited|fail_open"}`, `relay_rate_limit_evaluation_duration_seconds`, and `relay_rate_limit_redis_failures_total`. Dynamic customer UUIDs are never included in metric labels to prevent cardinality explosion.

### 4. Verification Commands

```bash
# 1. Run all unit and integration rate limiter tests (11 tests):
npm.cmd test -- tests/rateLimiter.test.ts

# 2. Run the full Relay test suite (40 tests):
npm.cmd test

# 3. Test HTTP 202 submission with rate limit headers:
curl -i -X POST http://localhost:3000/v1/notifications \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: $(uuidgen)" \
  -d '{"customerId":"d600ffb8-91ac-46ec-8837-c8455c9ffe5b","recipient":"user@example.com","channel":"email","payload":{"subject":"Hello","body":"World"}}'

# 4. View Rate Limiter Prometheus Metrics:
curl -s http://localhost:3000/metrics | grep "rate_limit"
```

---

## Milestone 6C: Tenant-Aware Fair Scheduling

Relay implements dual-stage tenant-aware fair scheduling across PostgreSQL outbox claiming and Redis/BullMQ worker execution to prevent high-volume tenants from monopolizing processing capacity while preserving durability, isolation, and throughput.

### 1. Configuration (`.env`)

| Variable | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `DB_POOL_MAX` | integer | `15` | Maximum PostgreSQL pool connections per process (sized for worker+dispatcher concurrency against Neon limits). |
| `FAIRNESS_ENABLED` | boolean | `true` | Enables or disables fair scheduling across outbox and workers. |
| `TENANT_MAX_CONCURRENT_JOBS` | integer | `2` | Maximum concurrent worker execution slots per tenant under contention. |
| `WORKER_CONCURRENCY` | integer | `5` | Total concurrent execution slots per worker process. |
| `DISPATCHER_BATCH_SIZE` | integer | `10` | Maximum outbox events claimed per dispatcher cycle. |

### 2. Key Architectural Features

- **Stage 1: Outbox Interleaved Round-Robin (IRR):** Uses a SQL window function `ROW_NUMBER() OVER (PARTITION BY n.customer_id ORDER BY oe.created_at ASC)` to claim events 1-by-1 across active tenants (`A1, B1, C1, A2, B2, C2...`) via `FOR UPDATE SKIP LOCKED`.
- **Stage 2: Distributed Dynamic Tenant Concurrency Control (DTCC):** Workers invoke an atomic Redis Lua script before claiming execution leases. Active jobs per tenant are capped at `TENANT_MAX_CONCURRENT_JOBS` (2) during multi-tenant contention.
- **Self-Healing Redis State:** Audits and auto-purges orphaned tenant keys from `active_tenants` and resynchronizes `total_active` counters on worker crashes without release.
- **Work-Conserving Burst:** When only one tenant has pending work, the Lua script permits bursting beyond quota up to total worker capacity (`WORKER_CONCURRENCY`), preventing idle worker capacity. Bursting is immediately revoked as soon as a second tenant claims execution.
- **Non-Destructive Deferral:** When a tenant's quota is exhausted, workers call `job.moveToDelayed(Date.now() + 500, token); throw new DelayedError();` without burning retry attempts or recording errors.
- **Fail-Open Resilience:** Redis connection issues or timeouts immediately fail open (`failOpen: true`), guaranteeing notification processing continues unabated during queue outages.
- **Bounded Redis Footprint:** Zero permanent per-tenant queues. Fairness keys in Redis auto-expire and are deleted immediately once a tenant's active job count reaches zero.
- **Prometheus Observability:** Tracks `relay_fair_scheduling_decisions_total{channel, decision}`, `relay_active_tenants`, `relay_tenant_scheduling_delay_seconds`, `relay_fairness_deferrals_total`, and `relay_worker_concurrency_utilization`. Dynamic tenant IDs are strictly excluded from metric labels.

### 3. Verification Commands

```bash
# 1. Run all fairness unit and integration tests (12 tests):
npm.cmd test -- tests/fairness.test.ts

# 2. Run the complete Relay test suite (52 tests across 8 test suites):
npm.cmd test

# 3. Run the reproducible bounded fairness benchmark (with direct PostgreSQL terminal verification):
npm.cmd run benchmark

# 4. Inspect fairness Prometheus metrics:
curl -s http://localhost:3000/metrics | grep -E "relay_fair|relay_active_tenants"
```

---

## Milestone 6D: Backpressure and Overload Protection

Relay implements admission control, multi-tier backpressure, and overload protection to prevent uncontrolled backlog growth, database connection exhaustion, and prolonged service degradation while preserving durable acceptance guarantees for requests that receive HTTP 202.

### 1. Configuration (`.env`)

| Variable | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `BACKPRESSURE_ENABLED` | boolean | `true` | Enables or disables the backpressure service globally. |
| `BACKPRESSURE_OUTBOX_DEGRADED_THRESHOLD` | integer | `500` | Unpublished outbox events count that triggers DEGRADED state. |
| `BACKPRESSURE_OUTBOX_OVERLOAD_THRESHOLD` | integer | `2000` | Unpublished outbox events count that triggers OVERLOADED state. |
| `BACKPRESSURE_QUEUE_DEGRADED_THRESHOLD` | integer | `1000` | Waiting queue jobs count that triggers DEGRADED state. |
| `BACKPRESSURE_QUEUE_OVERLOAD_THRESHOLD` | integer | `5000` | Waiting queue jobs count that triggers OVERLOADED state. |
| `BACKPRESSURE_CACHE_TTL_MS` | integer | `1000` | State evaluation cache duration in milliseconds to prevent database load spikes. |
| `BACKPRESSURE_RETRY_AFTER_SECONDS` | integer | `10` | Value sent in `Retry-After` header when rejecting with HTTP 503. |
| `BACKPRESSURE_DB_POOL_MAX_RATIO` | float | `0.90` | PostgreSQL pool utilization ratio that triggers OVERLOADED state. |
| `DISPATCHER_MAX_QUEUE_BACKLOG` | integer | `500` | Maximum downstream queue depth before dispatcher pauses outbox claims. |

### 2. Backpressure States and API Behavior

- **`NORMAL`:** Standard ingestion. All valid requests are accepted with HTTP 202 and durable transactional outbox records.
- **`DEGRADED`:** Backlog is elevated or Redis is temporarily down, but PostgreSQL is healthy. Ingestion continues with HTTP 202 and header `x-backpressure-state: DEGRADED`.
- **`OVERLOADED`:** Cluster resources are saturated or database is unhealthy.
  - **New Requests:** Rejected with `HTTP 503 Service Unavailable` (`code: "SYSTEM_OVERLOADED"`), `Retry-After: 10`, zero DB write transaction overhead, and automatic rate-limit quota refund.
  - **Safe Identical Replays:** Looked up via read-only query; returns HTTP 202 (`isReplay: true`) with original notification payload without creating duplicate outbox events.
  - **Conflicting Replays:** Rejected with HTTP 409 `IDEMPOTENCY_CONFLICT`.

### 3. Verification & Operational Commands

```bash
# 1. Run all 15 backpressure unit and integration tests:
npm.cmd test -- tests/backpressure.test.ts

# 2. Run the complete Relay regression test suite (67 tests across 9 suites):
npm.cmd test

# 3. Execute the 4-phase automated Failure Drill (Baseline -> Redis Outage -> Overload Defense -> Recovery):
npm.cmd run drill

# 4. Execute the multi-tenant reproducible Load Test:
npm.cmd run load-test

# 5. Execute API Smoke Test (Health, Ready, Metrics, and Notification Ingestion):
npx.cmd tsx scripts/smokeTest.ts

# 6. Inspect Backpressure Prometheus Metrics:
curl -s http://localhost:3000/metrics | grep "relay_backpressure"
```

### 4. Prometheus Observability Metrics

- `relay_backpressure_state{state="NORMAL|DEGRADED|OVERLOADED"}`: State indicator gauge.
- `relay_backpressure_current_state`: Numeric state enum (0=NORMAL, 1=DEGRADED, 2=OVERLOADED).
- `relay_outbox_backlog_total`: Count of unpublished outbox events in PostgreSQL.
- `relay_queue_backlog_total{channel="email|sms"}`: Waiting jobs in BullMQ queues.
- `relay_backpressure_rejections_total{reason="..."}`: Admission rejections counter.
- `relay_admission_check_duration_seconds`: Histogram of admission check evaluation latency.
- `relay_dependency_check_failures_total{dependency="postgres|redis"}`: Dependency probe failure counter.
- `relay_backpressure_state_seconds_total{state="..."}`: Time spent in each operational state.

---

## Milestone 7A: Recipient Notification Preferences

Relay implements tenant-scoped recipient notification preferences to provide granular opt-in/opt-out control over communication channels (`email`, `sms`) while preserving transactional consistency, durable auditability, and deterministic idempotency.

### 1. Key Invariants & Architectural Rules

- **Pre-Queue Ingestion Evaluation:** Recipient channel preferences are evaluated inside the **same active database transaction** as notification creation.
- **Suppression vs Acceptance Contract:**
  - **Accepted (`enabled: true` or default-allow):** Returns `HTTP 202 Accepted` with `status: "pending"`. Outbox event created; enqueued to BullMQ.
  - **Suppressed (`enabled: false`):** Returns `HTTP 200 OK` with `status: "suppressed"` and `suppressionReason: "recipient_preference_disabled"`.
  - **Zero Outbox Leakage:** Suppressed notifications generate **0 rows** in `outbox_events` and **0 jobs** in BullMQ queues.
- **Deterministic Idempotency:** Replaying a suppressed request with the same idempotency key permanently returns the original `HTTP 200` suppression response (`isReplay: true`), even if the recipient subsequently enables the channel.
- **Default-Allow Prototype Convention:** Unconfigured recipient channels default to allowed. *(Note: Prototype testing assumption, not a substitute for legally mandated affirmative marketing consent).*
- **Tenant Isolation:** Preferences are partitioned strictly by `(customer_id, recipient, channel)`. Disabling an email under Tenant A has zero effect on Tenant B.

### 2. Preference Management API

```bash
# 1. Opt-out an email recipient for a tenant:
curl -i -X PUT http://localhost:3000/v1/recipients/preferences \
  -H "Content-Type: application/json" \
  -d '{
    "customerId": "d600ffb8-91ac-46ec-8837-c8455c9ffe5b",
    "recipient": "user@example.com",
    "channel": "email",
    "enabled": false
  }'

# 2. Query preferences for a recipient:
curl -s "http://localhost:3000/v1/recipients/preferences?customerId=d600ffb8-91ac-46ec-8837-c8455c9ffe5b&recipient=user@example.com"
```

### 3. Verification Commands

```bash
# 1. Run all 13 preference integration tests:
npm.cmd test -- tests/preferences.test.ts

# 2. Run the complete Relay regression test suite (95 tests across 11 suites):
npm.cmd test
```

## Milestone 7B: Simulated Provider Failures, Retries & State Recovery

Relay implements configurable simulated external delivery adapters for Email (`SendGrid-Simulator`) and SMS (`Twilio-Simulator`) to demonstrate delivery success, transient backoff, permanent failure fast-termination, network timeout handling, and automatic recovery.

### 1. Provider Failure Taxonomy & State Invariants

- **`provider_accepted` (HTTP 200/202):** Provider confirmed acceptance of delivery request; realistic provider message ID generated; atomic worker lease released.
- **`processing` (HTTP 503 / HTTP 429):** Downstream transient outage or provider rate limit; PostgreSQL lease released immediately (`processing_locked_until = NULL`, `claim_token = NULL`); BullMQ retries using exponential backoff.
- **`failed` (HTTP 400 Bad Request):** Permanent, non-retryable rejection (invalid address / unroutable number); worker updates status to `failed` and throws `UnrecoverableError` to immediately abort BullMQ retries without consuming futile attempts.
- **`failed` (Retry Exhaustion):** Notification transitions to terminal `failed` status when maximum configured retry attempts (`job.opts.attempts = 5`) are exhausted.
- **`outcome_unknown` (Network Timeout):** Socket read times out after HTTP dispatch; outcome across the carrier boundary is indeterminate; worker updates status to `outcome_unknown` and halts blind retries to prevent duplicate message dispatch.
- **`suppressed` (Preference Opt-Out):** Ingested via API with `HTTP 200 OK`; zero outbox rows created; never invokes provider adapters.

### 2. Failure Drill Demonstration

Execute the standalone failure drill simulating all 6 operational failure and recovery scenarios:

```bash
npx tsx scripts/providerFailureDrill.ts
```

Drill Scenarios Verified:
1. Transient 503 Outage: Attempt 1 fails (503), lease released, Attempt 2 recovers with 202 (`provider_accepted`).
2. Provider 429 Rate Limiting: Attempt 1 rejected (429), Attempt 2 recovers with 202 (`provider_accepted`).
3. Permanent 400 Rejection: Fast termination to `failed` via `UnrecoverableError` (exactly 1 provider call).
4. Socket Read Timeout: Transition to `outcome_unknown` preventing duplicate message dispatch (1 call).
5. Retry Exhaustion: Prolonged 503 outage across all attempts transitions to terminal `failed`.
6. Clean Recovery: Unaffected traffic delivers cleanly with 202 (`provider_accepted`).

### 3. Automated Test Verification

```bash
# 1. Run all 15 provider failure tests:
npx.cmd vitest run tests/providerFailures.test.ts

# 2. Run the complete Relay regression test suite (95 tests across 11 suites):
npm.cmd test
```

## Milestone 7C: k6 Load Testing & Concurrency Benchmarks

Relay includes a genuine Grafana k6 load-testing suite ([`scripts/k6/load-test.js`](file:///c:/Users/HP/Desktop/relay-system/scripts/k6/load-test.js)) evaluating the prototype under baseline, gradual ramp-up, and spike traffic patterns against live remote Neon PostgreSQL and local Redis.

### 1. Test Scenarios Implemented

- **Scenario A (Baseline Ingress):** 3 constant VUs for 20s. Evaluates unconstrained normal operation. (Result: 1.70 req/s total & accepted, 100% accepted, 0 rate limits, 0 errors).
- **Scenario B (Gradual Ramp-Up):** 2 to 35 VUs over 50s. Identifies latency inflection (~20 VUs), rate limiting activation (HTTP 429 at 100 req/60s), and backpressure activation (HTTP 503 at >90% DB pool utilization). (Result: 28.33 total HTTP req/s evaluated, 4.13 accepted/s, 890 rate-limited, 352 overload deflections, 0 server crashes).
- **Scenario C (Short Spike):** Rapid burst to 30 VUs for 6s followed by immediate return to baseline. Demonstrates immediate load shedding via HTTP 503 and complete sub-2s recovery back to normal HTTP 202 acceptance. (Result: 23.34 total HTTP req/s, 3.30 accepted/s, 615 overload deflections, 0 errors).

### 2. Execution Instructions

```bash
# 1. Start Relay services (API on port 3000 + Outbox Dispatcher + Workers)
npx tsx scripts/k6/start-relay-services.ts

# 2. Seed dedicated test tenants (in a separate terminal)
npx tsx scripts/k6/seed-tenants.ts

# 3. Execute Scenario A: Baseline
.\bin\k6.exe run -e SCENARIO=baseline scripts/k6/load-test.js

# 4. Execute Scenario B: Gradual Ramp-Up
.\bin\k6.exe run -e SCENARIO=ramp_up scripts/k6/load-test.js

# 5. Execute Scenario C: Short Spike
.\bin\k6.exe run -e SCENARIO=spike scripts/k6/load-test.js

# 6. Verify post-test queue drain and provider acceptance
npx tsx scripts/k6/verify-drain.ts

# 7. Clean up test tenants and notification records
npx tsx scripts/k6/cleanup-tenants.ts
```

Detailed test metrics and analysis are documented in [`benchmarks/k6/REPORT.md`](file:///c:/Users/HP/Desktop/relay-system/benchmarks/k6/REPORT.md).

---

## Milestone 7D: Infrastructure Cost Estimation (100,000 Users)

Relay includes a comprehensive monthly infrastructure cost model for a deployment of **100,000 registered end-user recipients** across 100 tenant organizations, documented in [`benchmarks/COST-MODEL.md`](file:///c:/Users/HP/Desktop/relay-system/benchmarks/COST-MODEL.md) using official provider pricing pages verified on **30 October 2026**:

| Scenario | Active Ratio (MAU) | Monthly Volume | Channel Mix (Email / SMS) | Server Infra | Third-Party Telecom | Total Monthly Cost | Cost / 1k Notifs |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **Scenario A (Low)** | 30% (30k MAU) | 60,000 / mo | 85% Email / 15% SMS | $43.38 | $120.25 | **$163.63** | **$2.73** |
| **Scenario B (Expected)** | 60% (60k MAU) | 300,000 / mo | 80% Email / 20% SMS | $136.19 | $776.65 | **$912.84** | **$3.04** |
| **Scenario C (High)** | 85% (85k MAU) | 1,700,000 / mo | 75% Email / 25% SMS | $369.46 | $5,452.30 | **$5,821.76** | **$3.42** |

*(Under strict fixed baseline subscriptions vs. volume-variable consumption, Scenario B divides into **$130.69 fixed subscriptions** [compute, baseline DB, Redis, Grafana base, phone numbers, 10DLC campaign] and **$782.15 variable usage** [SES emails, SMS segments, storage, logs, egress], totaling **$912.84**).*

### Key Economic Findings
- **SMS Dominance:** Telecommunications carrier fees for SMS dwarf compute infrastructure, accounting for **85.1%** of monthly expenditure in Scenario B ($776.65 of $912.84). Sending 1,000 SMS ($12.50) is **125x more expensive** than sending 1,000 emails ($0.10 via Amazon SES).
- **Protective Safeguard Value:** Tenant Rate Limiting (Milestone 6B) and Recipient Preference Suppression (Milestone 7A) serve as essential financial circuit-breakers that protect tenant budgets from runaway billing.
- **Capacity Sufficiency Caveat:** Scenarios A (0.23 req/s peak) and B (1.16 req/s peak) operate within single-node prototype capacity (1.70 req/s baseline in k6). Scenario C (6.56 req/s peak) requires 2 horizontal API pods with connection pooling; this multi-node topology is budgeted but unbenchmarked in the single-node prototype.
- **Architectural Target Distinction:** The 50M/day target (1.5B/month) is 5,000x larger than the 100k-user workload and cannot be extrapolated linearly. At that scale, production systems require enterprise aggregator master service agreements, multi-tenant PostgreSQL database sharding, and distributed streaming brokers (Kafka/Pulsar).
