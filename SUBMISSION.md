# Relay — Graduation Submission

**Dev and Design HQ Product Design & Engineering Bootcamp**  
**Project:** Relay Notification Infrastructure Prototype  
**Author:** Graduate Candidate  
**Date:** 29 October 2026  
**Status:** Milestones 1–6D Fully Implemented & Verified (67/67 Tests Passing)

---

## 1. Project Name and Overview

**Relay** is a high-reliability, multi-tenant notification infrastructure prototype engineered to explore the distributed systems architecture required to ingest, schedule, and dispatch notifications reliably under heavy, uneven tenant workloads.

The project models the core challenges of an enterprise notification platform: durable ingestion guarantees, transactional decoupling, tenant isolation and abuse prevention, fair multi-tenant worker scheduling, backpressure admission defense, and comprehensive operational observability.

---

## 2. Problem Statement

Notification delivery systems operate under fundamentally conflicting requirements:
1. **Low-Latency Ingestion vs. Slow Downstream Providers:** Ingestion APIs must acknowledge submissions within milliseconds, whereas third-party delivery networks (email MTAs, SMS aggregators, push gateways) have variable, often multi-second network latencies and transient outage windows.
2. **Dual-Write Vulnerability:** Applications that write a record to a database and simultaneously publish to an in-memory message broker (e.g., Redis or RabbitMQ) suffer from distributed dual-write inconsistency: if the broker write fails after database commit, notifications are permanently lost; if the database rollback fails after publish, duplicate notifications are dispatched.
3. **Noisy Neighbor Inequity:** A single high-volume customer submitting a burst of 100,000 marketing messages can monopolize shared FIFO queues, starving time-sensitive transactional messages (e.g., password reset OTPs) from smaller tenants.
4. **Cascading Failure Under Overload:** Unbounded ingress during worker stalls or downstream provider outages rapidly fills database connections, exhausts storage, and crashes API nodes.

---

## 3. System Objectives

Relay was architected and built to satisfy four critical reliability principles:

1. **Durable Acceptance Invariant:** Every notification accepted with `HTTP 202 Accepted` is guaranteed to be durably committed to PostgreSQL alongside a transactional outbox event.
2. **At-Least-Once Delivery Semantics:** Decoupled asynchronous workers process notifications with explicit lease-locking and reconciliation, ensuring stuck or crashed worker jobs are automatically recovered without data loss.
3. **Multi-Tenant Protection:** Multi-layer tenant defenses prevent noisy neighbors from degrading service through Redis Lua sliding-window rate limiting and dual-stage tenant fair scheduling.
4. **Fail-Safe Admission Control:** An adaptive backpressure state engine rejects excess ingress at the HTTP routing layer with `HTTP 503 Service Unavailable` and `Retry-After` headers during database or queue saturation, preventing cluster collapse.

---

## 4. Architecture Summary

Relay follows a decoupled, pipeline-oriented architecture structured around the **Transactional Outbox Pattern**:

```mermaid
flowchart TD
    subgraph Ingestion ["Ingress Tier"]
        Client["HTTP Client / Tenant"] -->|"POST /v1/notifications"| ExpressAPI["Express API Server"]
        ExpressAPI -->|"1. Check Quota"| RateLimiter["Rate Limiter (Redis Lua)"]
        ExpressAPI -->|"2. Check Capacity"| AdmissionCtrl["Backpressure Engine"]
        ExpressAPI -->|"3. Atomic Write"| PG_Tx[("PostgreSQL Transaction")]
    end

    subgraph Storage ["Durable Persistence Tier (PostgreSQL)"]
        PG_Tx --> Notifications[("notifications")]
        PG_Tx --> Idempotency[("idempotency_keys")]
        PG_Tx --> Outbox[("outbox_events")]
    end

    subgraph Dispatch ["Asynchronous Dispatch Tier"]
        Dispatcher["Outbox Dispatcher Daemon"] -->|"Interleaved Claim (SKIP LOCKED)"| Outbox
        Dispatcher -->|"Gated by Queue Depth"| RedisQueues[("BullMQ Redis Queues")]
    end

    subgraph Workers ["Worker Execution Tier"]
        RedisQueues --> EmailWorker["Email Worker Pool"]
        RedisQueues --> SmsWorker["SMS Worker Pool"]
        EmailWorker -->|"Acquire Slot (Lua)"| DTCC["Tenant Fairness Controller"]
        SmsWorker -->|"Acquire Slot (Lua)"| DTCC
        EmailWorker -->|"Simulated Delivery"| FakeEmail["Fake Email Provider"]
        SmsWorker -->|"Simulated Delivery"| FakeSMS["Fake SMS Provider"]
        EmailWorker -->|"Mark Processed"| Notifications
        SmsWorker -->|"Mark Processed"| Notifications
    end

    subgraph Recovery ["Self-Healing & Observability"]
        Reconciliation["Reconciliation Daemon"] -->|"Detect Expired Leases"| Notifications
        Prometheus["Prometheus Metrics Server"] <---|"/metrics"| ExpressAPI
        Prometheus <---|Scrape| Dispatcher
        Prometheus <---|Scrape| EmailWorker
    end

    classDef primary fill:#2563eb,stroke:#1d4ed8,color:#ffffff;
    classDef storage fill:#059669,stroke:#047857,color:#ffffff;
    classDef worker fill:#d97706,stroke:#b45309,color:#ffffff;
    classDef alert fill:#dc2626,stroke:#b91c1c,color:#ffffff;

    class ExpressAPI,Dispatcher,Reconciliation primary;
    class PG_Tx,Notifications,Idempotency,Outbox,RedisQueues storage;
    class EmailWorker,SmsWorker,FakeEmail,FakeSMS worker;
    class AdmissionCtrl,RateLimiter,DTCC alert;
```

---

## 5. Technology Stack

- **Runtime & Language:** Node.js (v20+) with TypeScript (strict mode, target ES2022).
- **Web Framework:** Express 5.x with CORS, Zod schema validation, and typed routing.
- **Relational Database:** PostgreSQL 16 (AWS Neon cloud instance with PgBouncer connection pooling).
- **Asynchronous Queues & In-Memory State:** Redis 7.x (local instance) with BullMQ (v6.x) and atomic Lua scripts.
- **Client Library:** `pg` (node-postgres) with connection pooling and explicit transaction management; `ioredis` for direct Redis Lua evaluations.
- **Observability:** `prom-client` exposing standard Prometheus metrics for HTTP, outbox, workers, rate limiting, fairness, and backpressure.
- **Testing & Verification:** Vitest test runner, Supertest for HTTP endpoint testing, and standalone TypeScript drill/benchmark scripts executed via `tsx`.

---

## 6. Core API Endpoints

| Method | Path | Status Codes | Description |
| :--- | :--- | :--- | :--- |
| `GET` | `/v1/health` | `200 OK` | Liveness health check returning service name, status, and UTC timestamp. |
| `GET` | `/v1/ready` | `200 OK`, `503 Service Unavailable` | Readiness dependency check. Verifies PostgreSQL health. Degrades gracefully if Redis is unavailable while maintaining durable ingestion readiness. |
| `GET` | `/metrics` | `200 OK` | Exposes standard Prometheus text-format metrics across all subsystems. |
| `POST` | `/v1/notifications` | `202 Accepted`<br>`400 Bad Request`<br>`404 Not Found`<br>`409 Conflict`<br>`429 Too Many Requests`<br>`503 Service Unavailable` | Primary notification ingestion endpoint. Enforces tenant rate limits, backpressure admission, idempotency validation, and durable transactional persistence. |

---

## 7. Notification Ingestion Lifecycle

When a client submits `POST /v1/notifications`:

1. **Header Validation:** Requires a non-empty `Idempotency-Key` header; missing keys return `400 MISSING_IDEMPOTENCY_KEY`.
2. **Schema Parsing:** Validates `customerId` (UUID), `recipient`, `channel` (`email` or `sms`), and `payload` via Zod. Invalid schemas return `400 VALIDATION_ERROR`.
3. **Tenant Rate Limiting:** Executes an atomic Redis Lua sliding-window rate limit check (`rl:tenant:{customerId}`). If quota is exhausted, returns `429 RATE_LIMIT_EXCEEDED` with `Retry-After`.
4. **Admission Control:** Evaluates cluster state (`NORMAL`, `DEGRADED`, `OVERLOADED`):
   - Under `OVERLOADED`, safe identical replays return `202 Accepted` (`isReplay: true`), conflicting replays return `409 IDEMPOTENCY_CONFLICT`, and new submissions return `503 SYSTEM_OVERLOADED` with rate-limit quota refund.
5. **Database Transaction:**
   - Checks customer existence (`customers`).
   - Checks idempotency key within transaction (`idempotency_keys`).
   - Inserts notification record (`status = 'pending'`).
   - Inserts transactional outbox event (`outbox_events`).
   - Inserts idempotency mapping (`idempotency_keys`).
   - Executes `COMMIT`.
6. **HTTP Response:** Returns `HTTP 202 Accepted` with generated notification ID, status, and `RateLimit-*` headers.

---

## 8. Transactional Outbox Design

To eliminate the dual-write problem, Relay never publishes directly to Redis inside the HTTP request handler:

- **Atomic Storage:** Notifications and outbox events are written in the *same* database transaction. If the transaction rolls back, neither row exists; if it commits, both rows are guaranteed to exist.
- **Outbox Schema:**
  - `id`: UUID primary key.
  - `notification_id`: Foreign key referencing `notifications.id`.
  - `event_type`: Event type string (`notification.created`).
  - `published_at`: Timestamp populated once enqueued to BullMQ.
  - `attempts`: Retry counter incremented on each claim attempt.
  - `locked_until`: Distributed lease timestamp preventing concurrent dispatcher claims.
  - `failed_at`: Set when attempts exceed `DISPATCHER_MAX_ATTEMPTS` (5).
- **Claim Query:** Uses PostgreSQL `FOR UPDATE SKIP LOCKED` combined with a window function `ROW_NUMBER() OVER (PARTITION BY n.customer_id ORDER BY oe.created_at ASC)` to interleave outbox events across active tenants and guarantee zero duplicate claims between concurrent dispatchers.

---

## 9. Idempotency Guarantees

Relay provides strict tenant-scoped idempotency guarantees:

- **Database Constraint:** Composite unique index on `idempotency_keys(customer_id, idempotency_key)`.
- **Payload Hashing:** SHA-256 hash of canonical request body stored in `request_hash`.
- **Identical Replay Contract:** When a request is repeated with the same `Idempotency-Key` and matching payload hash, Relay returns the existing notification with `HTTP 202 Accepted` (`isReplay: true`). No new outbox event or background job is created.
- **Conflicting Replay Contract:** When an `Idempotency-Key` is reused with a different payload, Relay rolls back and returns `HTTP 409 Conflict` (`IDEMPOTENCY_CONFLICT`).
- **Concurrent Request Safety:** Concurrent submissions with identical keys are arbitrated at the PostgreSQL index level; the winning transaction commits, while the losing transaction catches unique violation (`23505`), rolls back, and returns the committed record without duplicate processing.

---

## 10. Redis and BullMQ Processing

Relay separates queueing into distinct BullMQ channel queues (`email-notifications`, `sms-notifications`):

- **Deterministic Job IDs:** Jobs are published with explicit IDs (`notif-{notification_id}`). BullMQ deduplicates duplicate enqueue attempts with identical job IDs.
- **Decoupled Workers:** Email and SMS workers run independently with configurable concurrency (`WORKER_CONCURRENCY = 5`).
- **Simulated Provider Execution:** Workers simulate delivery network latency (100–300ms) and log completion without sending external emails or SMS.
- **Lifecycle Progression:** When a worker picks up a job:
  1. Claims an execution lease in PostgreSQL (`status = 'processing'`).
  2. Acquires a fair scheduling concurrency slot via Redis Lua.
  3. Executes delivery simulation.
  4. Updates status in PostgreSQL (`status = 'processed'`).
  5. Releases fair scheduling slot in Redis.

---

## 11. Retry and Reconciliation

Relay implements end-to-end self-healing mechanisms for worker and network failures:

1. **BullMQ Automatic Retries:** Transient worker failures are retried up to 3 times with exponential backoff.
2. **Worker Lease Locking:** When a worker starts processing a notification, it writes a lease lock to PostgreSQL (`processing_locked_until = NOW() + 60s`).
3. **Reconciliation Service:** A standalone reconciliation daemon (`src/reconciliation.ts`) periodically scans PostgreSQL for orphaned notifications (`status = 'processing' AND processing_locked_until < NOW()`):
   - If `retry_count < 3`: Clears the expired lease, resets status to `pending`, increments `retry_count`, and emits a new outbox event for re-dispatch.
   - If `retry_count >= 3`: Marks status as `failed` with failure reason logged.
4. **Outcome Unknown State:** If an unrecoverable failure occurs during lease clearance, the notification is transitioned to `outcome_unknown` for operator audit.

---

## 12. Tenant-Level Rate Limiting

Implemented in Milestone 6B to protect ingestion capacity from tenant abuse:

- **Algorithm:** Atomic sliding-window rate limiter powered by a custom Redis Lua script executing against Redis Sorted Sets (`rl:tenant:{customerId}`).
- **Boundary Accuracy:** Uses millisecond scores (`Date.now()`) with `ZREMRANGEBYSCORE` to eliminate fixed-window burst vulnerabilities ($2\times \text{limit}$ at window boundaries).
- **Default Quota:** 100 requests per 60-second sliding window (`RATE_LIMIT_MAX_REQUESTS = 100`, `RATE_LIMIT_WINDOW_SECONDS = 60`).
- **Standard Headers:** Emits `RateLimit-Limit`, `RateLimit-Remaining`, `RateLimit-Reset`, and `Retry-After` on HTTP 429.
- **Fail-Open Policy:** If Redis is down or times out (>500ms), the rate limiter logs a throttled warning and fails open (`allowed: true, failOpen: true`), prioritizing durable ingestion over quota enforcement.

---

## 13. Tenant-Aware Fair Scheduling

Implemented in Milestone 6C to resolve **Dual-Stage Head-of-Line (HoL) Blocking**:

### Stage 1: Outbox Interleaved Round-Robin (IRR)
The Outbox Dispatcher claims unpublished events using a SQL window function:
```sql
SELECT sub.id FROM (
  SELECT oe.id,
         ROW_NUMBER() OVER (PARTITION BY n.customer_id ORDER BY oe.created_at ASC) as tenant_turn,
         oe.created_at
  FROM outbox_events oe
  JOIN notifications n ON oe.notification_id = n.id
  WHERE oe.published_at IS NULL AND oe.failed_at IS NULL
    AND (oe.locked_until IS NULL OR oe.locked_until < NOW())
) sub
ORDER BY sub.tenant_turn ASC, sub.created_at ASC
LIMIT 10
FOR UPDATE SKIP LOCKED;
```
Claims 1 item per active tenant per cycle (`A1, B1, C1, A2, B2, C2...`), preventing high-volume tenants from monopolizing dispatch batches.

### Stage 2: Distributed Dynamic Tenant Concurrency Control (DTCC)
Workers invoke an atomic Redis Lua script (`acquireSlot`) before processing:
- **Guaranteed Concurrency Limit:** Capped at `TENANT_MAX_CONCURRENT_JOBS = 2` concurrent jobs when multiple tenants contend for worker capacity.
- **Work-Conserving Burst:** When only one tenant has active work, the Lua script permits that tenant to burst up to 100% of worker capacity (`WORKER_CONCURRENCY = 5`), preventing idle capacity waste. Bursting is immediately revoked as soon as a second tenant claims execution.
- **Non-Destructive Deferral:** When quota is exhausted under contention, workers defer the job using BullMQ's `DelayedError` (`job.moveToDelayed(Date.now() + 500, token); throw new DelayedError();`), preserving notification state and retry counters while freeing the worker thread for waiting tenants.

---

## 14. Backpressure and Overload Protection

Implemented in Milestone 6D to prevent uncontrolled backlog growth and database exhaustion:

- **State Hierarchy:**
  - `NORMAL`: Accept all requests with `HTTP 202`.
  - `DEGRADED`: Accept requests with `HTTP 202` and `x-backpressure-state: DEGRADED` header (outbox backlog $\ge 500$, queue backlog $\ge 1,000$, or Redis offline with outbox $< 2,000$).
  - `OVERLOADED`: Reject new submissions with `HTTP 503 SYSTEM_OVERLOADED` and `Retry-After: 10` (outbox backlog $\ge 2,000$, queue backlog $\ge 5,000$, or database unhealthy).
- **Safe Replay Under Overload:** Clients replaying previously accepted requests receive `HTTP 202 Accepted` (`isReplay: true`) via read-only idempotency checks with zero outbox writes.
- **Rate Limit Token Refund:** Tokens consumed by requests rejected with HTTP 503 or served as safe replays are immediately refunded via atomic `ZREM` using a globally unique token `${now}:${crypto.randomUUID()}`.
- **Downstream Dispatcher Throttling:** The Outbox Dispatcher inspects total waiting and delayed queue depth (`DISPATCHER_MAX_QUEUE_BACKLOG = 500`); if exceeded, claiming pauses until queues drain.
- **Damped Dependency Health Probe:** Database health check executes a bounded probe (2,500ms timeout) with a 2-strike requirement (`consecutiveDbFailures >= 2`), eliminating false-positive overload triggers caused by transient internet latency to remote cloud databases.

---

## 15. Observability

Relay exposes standard Prometheus metrics at `GET /metrics` across all operational tiers:

- **API & Ingestion:** `relay_http_requests_total`, `relay_http_request_duration_seconds`, `relay_validation_failures_total`, `relay_idempotency_conflicts_total`.
- **Notification Lifecycle:** `relay_notifications_accepted_total`, `relay_notifications_processed_total`, `relay_notifications_failed_total`, `relay_notifications_in_outcome_unknown_total`.
- **Transactional Outbox:** `relay_outbox_events_awaiting_publication`, `relay_outbox_events_published_total`, `relay_outbox_events_failed_total`.
- **Worker Execution:** `relay_worker_jobs_processed_total`, `relay_worker_job_processing_duration_seconds`, `relay_worker_jobs_active`, `relay_worker_leases_expired_total`.
- **Rate Limiting:** `relay_rate_limit_evaluations_total`, `relay_rate_limit_evaluation_duration_seconds`, `relay_rate_limit_redis_failures_total`.
- **Tenant Fairness:** `relay_fair_scheduling_decisions_total`, `relay_active_tenants`, `relay_tenant_scheduling_delay_seconds`, `relay_fairness_deferrals_total`, `relay_worker_concurrency_utilization`.
- **Backpressure:** `relay_backpressure_state`, `relay_backpressure_current_state`, `relay_outbox_backlog_total`, `relay_queue_backlog_total`, `relay_backpressure_rejections_total`, `relay_admission_check_duration_seconds`, `relay_dependency_check_failures_total`, `relay_backpressure_state_seconds_total`.
- **Cardinality Invariant:** Dynamic tenant UUIDs and notification IDs are strictly excluded from metric labels to prevent Prometheus memory exhaustion.

---

## 16. Failure-Drill Evidence

Executed via automated script [`scripts/failureDrill.ts`](file:///c:/Users/HP/Desktop/relay-system/scripts/failureDrill.ts) against the live Neon cloud PostgreSQL database and Redis:

- **Phase 1: Baseline Health:** Ingested 5 notifications under `NORMAL` state; 100% accepted with HTTP 202 and published.
- **Phase 2: Redis Outage Simulation:** Disconnected Redis; system transitioned to `DEGRADED`. Ingested 5 notifications; 100% accepted with HTTP 202 and header `x-backpressure-state: DEGRADED`. Mid-outage verification confirmed all 5 records durably persisted in PostgreSQL.
- **Phase 3: Overload Admission Defense:** Injected pending outbox backlog exceeding threshold; system transitioned to `OVERLOADED`. New submissions rejected with `HTTP 503 SYSTEM_OVERLOADED` and `Retry-After: 10`. Identical replays returned `HTTP 202` (`isReplay: true`) with zero outbox events created. Conflicting replays rejected with `HTTP 409 IDEMPOTENCY_CONFLICT`. Database audit confirmed zero rows inserted after 503 rejections.
- **Phase 4: Recovery & Drain:** Restored Redis and cleared backlog; system returned to `NORMAL`. Outbox Dispatcher claimed and published all events; workers drained all notifications to `processed` status.

---

## 17. Automated Test Results

The automated regression test suite contains **67 tests across 9 test suites, achieving 100% pass rate**:

```bash
npm.cmd test
```

```
Test Files  9 passed (9)
     Tests  67 passed (67)
  Duration  83.89s
```

- `tests/backpressure.test.ts` (15/15 passed)
- `tests/fairness.test.ts` (12/12 passed)
- `tests/rateLimiter.test.ts` (11/11 passed)
- `tests/metrics.test.ts` (9/9 passed)
- `tests/notifications.test.ts` (8/8 passed)
- `tests/outbox.test.ts` (4/4 passed)
- `tests/reconciliation.test.ts` (3/3 passed)
- `tests/readiness.test.ts` (3/3 passed)
- `tests/health.test.ts` (2/2 passed)

---

## 18. Benchmark and Load-Test Results

### Bounded Fairness Benchmark (`scripts/benchmark.ts`)
- **Workload:** Tenant A (40 items), Tenant B (10 items), Tenant C (10 items) = 60 total notifications.
- **Measured Empirical Results:**
  - **100.0% Terminal Completion:** All 60 notifications reached `processed` status in PostgreSQL.
  - **Tenant B (10 items):** First completed in 8.78s; 100% completed in **33.70s**.
  - **Tenant C (10 items):** First completed in 14.90s; 100% completed in **37.27s**.
  - **Tenant A (40 items):** 100% completed in **55.64s** (at exactly 50% completion when B and C finished).
  - **FIFO Comparison:** The measured fairness benchmark showed low-volume tenants completing before the high-volume tenant. The FIFO comparison is theoretical and was not independently benchmarked.

### Reproducible Multi-Tenant Load Test (`scripts/loadTest.ts`)
- **Workload:** 70 requests across two tenants under concurrent batching.
- **Phase 1 Baseline Ingress (50 requests):**
  - **HTTP 202 Accepted: 50 / 50 (100.0%)**
  - **HTTP 429 Rate-Limited: 0**
  - **HTTP 503 Overloaded: 0**
  - Ingress Throughput: 4.0 req/s (against AWS Neon London cloud PostgreSQL)
  - API Latency: P50 = 1,086 ms, P95 = 2,826 ms, P99 = 2,827 ms
- **Phase 2 Overload Admission Defense (20 requests):**
  - 100% (20/20) cleanly rejected with `HTTP 503 SYSTEM_OVERLOADED`.
  - **Rejection Latency P50: 136 ms** (an 87.5% latency reduction compared to baseline, confirming zero database transaction overhead during overload).
- **Phase 3 Worker Draining:**
  - 50 items drained to `processed` in 45.16 seconds (drain rate: 1.1 notifications/sec).

---

## 19. Architecture Trade-offs

| Decision | Trade-off Made | Rationale |
| :--- | :--- | :--- |
| **PostgreSQL Outbox vs Direct Broker Publish** | Adds database write amplification and polling latency (~100–500ms) | Guarantees atomic acceptance and eliminates distributed dual-write message loss |
| **Shared BullMQ Queues vs Per-Tenant Queues** | Requires distributed Redis Lua slot locking for fairness | Prevents Redis memory exhaustion and idle polling storms across thousands of tenants |
| **Fail-Open Rate Limiting** | Temporarily permits unthrottled traffic during Redis downtime | Protects durable ingestion into PostgreSQL as the primary platform objective |
| **Cached Backpressure State (1,000ms TTL)** | Permits a bounded ingress overshoot of 5–50 items during overload spikes | Eliminates full-table `COUNT(*)` query storms that would crash PostgreSQL under heavy load |
| **Strict Bounded Labels on Prometheus Metrics** | Prevents per-tenant metric slicing in Prometheus dashboards | Eliminates label cardinality explosion and protects Prometheus memory stability |

---

## 20. Known Limitations

To remain technically honest and defensible:

1. **Simulated Providers:** The prototype uses simulated email and SMS workers; real third-party API integration (e.g. Twilio, SendGrid) with upstream rate-limit handling and webhook callbacks is not implemented.
2. **Tenant Authentication:** Tenant identity is supplied via `customerId` in the request body for bootcamp demonstration purposes; production deployments must derive tenant identity from authenticated API keys or JWT tokens.
3. **Delivery Semantics:** Relay guarantees **at-least-once** delivery. Due to network failures, worker crashes, and lease timeouts, duplicate sends to end-recipients can occur if the provider lacks recipient-level idempotency keys. Relay does not claim exactly-once delivery.
4. **50M Notifications/Day Scale:** The target architecture of 50M/day (~580 req/s continuous, ~2,500 req/s peak) is an architectural design benchmark. The prototype was evaluated at 4–5 req/s against a single serverless cloud database instance.
5. **Static Thresholds:** Backpressure thresholds are static environment variables; in auto-scaling production environments, thresholds should adapt dynamically to worker cluster size.

---

## 21. Local Setup and Reproduction Instructions

### Prerequisites
- Node.js v20+ and npm
- Redis running locally on port 6386 (or standard 6379 configured via `.env`)
- PostgreSQL database (local or cloud instance)

### 1. Installation & Environment Configuration
```bash
git clone <repository-url>
cd relay-system
npm install

# Copy environment template
cp .env.example .env
# Edit .env to set your DATABASE_URL and REDIS_URL
```

### 2. Verify Database Connection & Migrations
```bash
npx tsx src/database/check-connection.ts
```
The database schema is structured into 5 sequential migrations in [`src/database/migrations/`](file:///c:/Users/HP/Desktop/relay-system/src/database/migrations):
- `001_initial.sql`: Core tables (`customers`, `notifications`, `outbox_events`, `idempotency_keys`) and baseline indexes.
- `002_outbox_improvements.sql`: Outbox claiming and lease recovery columns (`claimed_at`, `attempts`, `locked_until`).
- `003_worker_leases.sql`: Worker lease columns on `notifications` (`processing_started_at`, `processing_locked_until`, `claim_token`).
- `004_outbox_failure_handling.sql`: Terminal failure columns on `outbox_events` (`failed_at`, `failure_reason`, `last_error`).
- `005_notification_lifecycle.sql`: Notification status check constraint update adding `'processed'`.

### 3. Build & Run Tests
```bash
# Compile TypeScript (0 errors)
npm run build

# Run complete 67-test automated regression suite
npm test
```

### 4. Run Operational Scripts
```bash
# Run runtime API smoke test (health, ready, metrics, ingestion)
npm run smoke

# Run 4-phase automated failure drill (Redis outage & overload recovery)
npm run drill

# Run multi-tenant fairness benchmark
npm run benchmark

# Run reproducible multi-tenant load test
npm run load-test
```

### 5. Running the Complete System Daemons
```bash
# Terminal 1: API Server
npm run dev

# Terminal 2: Outbox Dispatcher Daemon
npm run dispatcher

# Terminal 3: Email and SMS Worker Pool
npm run workers

# Terminal 4: Lease Reconciliation Daemon
npm run reconcile
```

### 6. Live Presentation Guide
For a structured 10-minute live demonstration script with pre-demo checklist, verbatim commands, database inspection queries, and fallback procedures, refer to [`DEMO-GUIDE.md`](file:///c:/Users/HP/Desktop/relay-system/DEMO-GUIDE.md).

---

## 22. Future Improvements

For production evolution beyond the bootcamp prototype:

1. **Table Partitioning:** Implement daily declarative partitioning on `outbox_events` and `notifications` (`outbox_events_YYYY_MM_DD`) to keep B-tree indexes bounded and optimize count queries.
2. **Dynamic Tiered Quotas:** Replace uniform fairness and rate limits with subscription-tier quotas (e.g. Free: 10 req/min & 1 slot; Enterprise: 1,000 req/min & 50 slots).
3. **Dead-Letter Queues (DLQ) & Operator UI:** Introduce BullMQ dead-letter queues with an administrative dashboard for inspecting and replaying failed notifications.
4. **Read Replica Offloading:** Direct read-only idempotency checks (`findReadOnly`) during overload to PostgreSQL read replicas.
5. **Adaptive Backpressure:** Dynamically compute overload thresholds as a function of active worker container count ($N_{\text{workers}} \times C_{\text{concurrency}} \times 20$).

---

## 23. Final Engineering Reflection

Building Relay demonstrated that building reliable distributed systems is fundamentally about **managing trade-offs at failure boundaries**:

- Achieving "durability" requires accepting asynchronous dispatch latency through the Transactional Outbox pattern.
- Achieving "fairness" in a multi-tenant queue requires coordination across both the database claim tier and the worker execution tier—solving HoL blocking at only one layer leaves the system vulnerable at the other.
- Achieving "overload protection" requires fast-path rejections that do not touch the database, combined with careful token refunding and read-only replay checks so innocent clients are never penalized.

Relay's implementation prioritizes correctness, mathematical invariants, and defensible architectural choices over superficial feature breadth.

