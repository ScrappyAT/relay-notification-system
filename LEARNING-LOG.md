# Relay — Learning Log

1. **Async processing:** persist and return 202; workers deliver. Tradeoff: client tracks status.
2. **Transactional outbox:** atomic DB notification and outbox; Redis outage cannot lose accepted work. Tradeoff: possible duplicate queue publication.
3. **Uncertain sends:** timeout -> outcome_unknown; provider reconciliation or policy-driven retry. Tradeoff: no universal exactly-once external delivery.
4. **Fairness:** priority/channel lanes, shared limiter, gradual campaign expansion. Tradeoff: scheduler complexity.
5. **Storage:** narrow rows, selective indexes, retention partitions, deferred tenant sharding. Tradeoff: partitioned uniqueness and routing.
6. **API:** tenant-scoped authentication and idempotent creation. Tradeoff: key expiry and concurrent-request handling.

**Next:** implement critical path, record actual evidence and revise decisions.

---

## 7. Milestone 5: Redis Outage and Recovery Drill (28 October 2026)

### 7.1 Test Objective & Scope
The objective of this drill was to validate the core resilience hypothesis of the Transactional Outbox pattern (Decision #2): that incoming notification requests can be durably accepted and acknowledged (HTTP 202 Accepted) by the API while the queuing substrate (Redis) is completely offline, without losing messages, and that the system automatically recovers and delivers backlogged work once Redis returns to service.

### 7.2 Test Procedure
1. **Target Architecture Setup:** The Relay API, PostgreSQL database, Outbox Dispatcher (`OutboxDispatcher`), and SMS/Email workers were configured and active.
2. **Failure Injection:** Redis connectivity was intentionally disrupted by terminating the Redis instance / reconfiguring the service target to an unreachable port (`port 6386`), forcing incoming connection attempts to fail immediately with `ECONNREFUSED`.
3. **Ingestion Under Failure:** An SMS notification request was submitted to `POST /v1/notifications` with a valid `Idempotency-Key` header.
4. **Ingestion Verification:** Verified that the API successfully committed the PostgreSQL transaction containing the customer record, idempotency key, notification record, and outbox event, returning HTTP `202 Accepted` to the client.
5. **Outage Behavior:** The Outbox Dispatcher attempted to poll and publish unpublished outbox events to BullMQ, encountering `ECONNREFUSED` on port 6386, releasing claimed row locks back to the pool, and leaving the events in an unpublished state without data corruption or crash.
6. **Service Restoration:** Redis was restarted and made reachable again on the target port.
7. **Recovery & Publication:** The Outbox Dispatcher reconnected, claimed the pending outbox event on its next poll cycle, and published the job to the Redis `sms-notifications` queue.
8. **Worker Consumption:** The SMS worker picked up the job from the queue, acquired an atomic worker lease in PostgreSQL, executed internal processing, and marked the notification as `processed`.

### 7.3 Test Evidence & Telemetry
- **Notification ID:** `16abf08c-837b-4b50-86ae-c327e7795f5d`
- **Channel:** `SMS`
- **Accepted / Created Timestamp:** `11:07:05 UTC` (2026-10-28)
- **Published to Queue Timestamp:** `11:08:01 UTC` (2026-10-28)
- **Recovery Interval:** approximately `55.4 seconds` elapsed from HTTP acceptance to successful queue publication.
- **Connection Diagnostics:** Redis connection failed with `ECONNREFUSED` on port `6386`.
- **Reconnection:** Redis subsequently reconnected successfully without requiring process restarts of the API or Dispatcher.
- **Publication Outcome:** Dispatcher successfully published the notification into the SMS BullMQ queue (`jobId: notif-16abf08c-837b-4b50-86ae-c327e7795f5d`).
- **Final Notification Status:** `processed`
- **Outbox Attempts:** `1` (claimed and published in 1 operational attempt after connectivity was restored)
- **Outbox Failed At:** `null` (event was never marked failed or dead-lettered)

### 7.4 Observations
- **Decoupled Availability:** Ingress availability was 100% decoupled from queue availability. The API server did not block or depend on Redis to accept the notification.
- **Clean Connection Retries:** `ioredis` handled the connection failure gracefully, logging `ECONNREFUSED` without unhandled rejections crashing the node process.
- **Lease Safety on Queue Error:** When the queue push failed during the outage, the dispatcher caught the error, invoked `releaseClaim` to reset `locked_until = NULL`, allowing immediate eligibility once connectivity recovered rather than stalling until lease expiration.
- **Deterministic Job Deduplication:** The dispatcher published using deterministic job IDs (`notif-${notification.id}`), ensuring that even if transient network acknowledgements were lost, BullMQ would deduplicate repeated queue additions.
- **End-to-End Delivery:** Once published, the worker transitioned the notification through the lifecycle state machine: `pending` -> `queued` -> `processing` -> `processed`.

### 7.5 Lessons Learned
1. **The Transactional Outbox Delivers On Its Core Promise:** Accepted notifications remain safe in PostgreSQL storage regardless of Redis health. Redis serves strictly as disposable transient transport, not as a system of record.
2. **Explicit Error Release Avoids Stale Latency:** Releasing row claim locks (`locked_until = NULL`) explicitly on caught queue errors prevents events from being blocked for the full 60-second lease window, minimizing recovery latency upon reconnection.
3. **Deterministic Job IDs Prevent Duplicate Deliveries:** Coupling the outbox pattern with deterministic BullMQ job IDs (`notif-${id}`) closes the race condition where a dispatcher publishes successfully but crashes before updating `published_at`.

### 7.6 Remaining Limitations & Observability Gaps
- **Absence of Mid-Outage DB Snapshot:** **Important:** No database snapshot or independent read query was captured while Redis was unavailable. While the acceptance timestamp (`11:07:05 UTC`), publication timestamp (`11:08:01 UTC`), and logged `ECONNREFUSED` errors confirm the outage window and eventual delivery, the intermediate pending/unpublished state in PostgreSQL was not independently sampled during the exact downtime window. Future drills must schedule automated database snapshot polling during the fault injection interval.
- **Single Dispatcher Bottleneck:** The current prototype uses a polling interval (`1000ms`). During prolonged outages, a large accumulation of unpublished events could create dispatch lag upon recovery. Paged batching (`LIMIT 10`) ensures steady recovery but requires tuning for high-throughput spikes.
- **Alerting & Dead-Letter Telemetry:** Outbox events that exceed `maxAttempts` (10) are marked with `failed_at` and `failure_reason`, but automated monitoring and alerting for rows with `failed_at IS NOT NULL` remain to be integrated with an external alerting pipeline.

---

## 8. Milestone 6A: Observability and Operational Metrics (28 October 2026)

### 8.1 Architectural Context & Strategy
Before implementing multi-tenant rate limiting, fair queuing, and backpressure in subsequent milestones, the system requires granular, low-overhead operational visibility across its distributed components. 

### 8.2 Key Implementation Decisions & Trade-offs
1. **Metric Label Cardinality and Safety:**
   - *Decision:* Metric labels are strictly bounded to low-cardinality enums (`method`, `route`, `status_code`, `channel`, `status`). All dynamic UUIDs, recipient phone numbers, email addresses, idempotency keys, and tenant/customer identifiers are strictly forbidden as Prometheus labels.
   - *Route Normalization:* Implemented `normalizeRoute()` to map dynamic paths (e.g., `/v1/notifications/:id`) into static route strings, preventing memory exhaustion and denial-of-service via label cardinality explosion.
   - *Trade-off:* Per-tenant metrics cannot be scraped directly from raw Prometheus labels without a bounded tiering strategy (e.g. tier="enterprise", region="us-east"). Detailed per-tenant audit remains in PostgreSQL delivery attempts and access logs.

2. **Multi-Process Telemetry Across Independent Node.js Daemons:**
   - *Challenge:* Relay runs the API, outbox dispatcher, workers, and reconciliation service as independent Node.js processes with separate memory heaps.
   - *Solution:* Implemented a dual-layered telemetry architecture:
     - Each background daemon process supports an independent lightweight native HTTP metrics server (`startProcessMetricsServer`) on dedicated ports (`DISPATCHER_METRICS_PORT`, `WORKERS_METRICS_PORT`, `RECONCILIATION_METRICS_PORT`) for fine-grained process-level scraping in containerized environments.
     - The primary API process (`GET /metrics`) dynamically samples global queue health (BullMQ `getJobCounts`) and transactional outbox backlog (`SELECT COUNT(*) FROM outbox_events WHERE published_at IS NULL`) on scrape when reachable, ensuring standard single-endpoint monitoring captures system-wide pipeline health without inter-process IPC dependencies.

3. **Readiness vs. Liveness & Fault-Isolated Ingestion:**
   - *Liveness (`GET /v1/health`):* Fast, zero-dependency process heartbeat returning `200 OK`.
   - *Readiness (`GET /v1/ready`):* Reflects the dependencies required strictly for the API's durable acceptance path. Because Relay accepts notifications into PostgreSQL transactional outbox before queue publication, the API is `ready` (HTTP 200) as long as PostgreSQL is healthy. If Redis is unavailable, `/v1/ready` returns HTTP 200 with `dependencies.redis = "unavailable"` and a degradation note, accurately preserving ingress availability. If PostgreSQL fails, it immediately returns HTTP 503 (`not_ready`).

4. **Redis Reconnection Observability & Log Throttling:**
   - Replaced unthrottled connection error logging with log throttling (exponential/sampled reporting on consecutive failures: 1st, 5th, 25th, or every 30s) to prevent log-disk exhaustion during outages.
   - Incorporated bounded exponential backoff with jitter (100ms–5000ms ± 20%) into `ioredis` reconnection strategy.
   - Added connection telemetry: `relay_redis_connected` (gauge), `relay_redis_disconnects_total`, `relay_redis_reconnects_total`, and `relay_redis_consecutive_failures`.

5. **Capacity Linkage to 50M/day Target Design:**
   - 50M notifications/day requires 579/s average and ~5,787/s peak throughput. The histogram buckets in `relay_api_request_duration_seconds` (5ms–10s) and `relay_dispatcher_publication_duration_seconds` (5ms–5s) are aligned to measure millisecond-level ingress latency and dispatcher queue publication delays.
   - Note: The local prototype demonstrates correct architectural observability and pipeline tracking; it does **not** claim to have demonstrated 50-million-per-day production throughput on local hardware.

### 8.3 Remaining Limitations
- **Metric Scraping in Ephemeral Environments:** In short-lived serverless or single-port environments, background processes require either a Prometheus Pushgateway or centralized database-backed metrics rollup.
- **Histogram Memory Footprint:** High bucket counts across multiple route labels require ongoing monitoring to keep memory consumption bounded under heavy multi-tenant load.

---

## 9. Milestone 6B: Tenant-Level Rate Limiting (28 October 2026)

### 9.1 Overview & Goals
Milestone 6B introduces tenant-level sliding window rate limiting on `POST /v1/notifications` to protect Relay against abusive ingestion traffic and noisy-neighbor starvation while preserving durable acceptance into PostgreSQL.

### 9.2 Key Implementation Decisions & Trade-offs

1. **Sliding Window Log via Atomic Redis Lua:**
   - *Considered Alternatives:* Fixed window counter, Token bucket, Leaky bucket.
   - *Decision:* Implemented an atomic Redis Lua script executing a Sliding Window Log using a Redis Sorted Set (`ZSET`) keyed by `rl:tenant:{customerId}` with millisecond timestamp scores.
   - *Rationale:* Fixed window counters allow $2 \times \text{limit}$ bursts at boundary crossings. The sliding window log accurately calculates requests in the preceding 60 seconds at any millisecond offset. Using an atomic Lua script guarantees that eviction (`ZREMRANGEBYSCORE`), counting (`ZCARD`), insertion (`ZADD`), and TTL refresh (`PEXPIRE`) occur in a single Redis round-trip without race conditions between concurrent requests or distributed API instances.
   - *Trade-off:* Each request stores an entry in Redis (~50 bytes) instead of a single integer counter. At prototype scale and for up to 10,000 active tenants at 100 req/min, total memory is under 50 MB. For massive scale (>100,000 tenants), a sliding window counter or token bucket can be adopted to achieve $O(1)$ memory.

2. **Security & Tenant Identity Boundary:**
   - *Prototype Design:* The API accepts `customerId` within the JSON request body (validated against PostgreSQL `customers`).
   - *Production Security Warning:* In production, deriving tenant identity from the request body creates an obvious spoofing risk. Production architectures must extract tenant identity exclusively from cryptographically verified credentials (mTLS certificates, HMAC-signed API keys, or verified JWT tokens). The prototype keeps `customerId` in the body strictly to avoid introducing an unrequested authentication system while keeping the rate limiter's internal interface clean (`consume(tenantId: string)`).

3. **Idempotency Interaction: Pre-Consumption with Safe Replay Refunds:**
   - *DDoS Attack Vector:* An attacker could send 10,000 requests/sec with identical idempotency keys to saturate PostgreSQL database connections and CPU if rate limits were evaluated after database checks.
   - *Solution:* Rate limit quota is consumed *before* database execution. When a request completes and is found to be a safe identical idempotency replay (`isReplay === true`, returning existing notification record with HTTP 202), Relay issues a refund (`rateLimiter.refund()`) executing `ZREM` in Redis.
   - *Conflict Handling:* Conflicting replays (HTTP 409 Conflict) do **not** receive refunds, penalizing erroneous client behavior and preventing unbounded database conflict generation.

4. **Redis Failure Policy: Fail-Open for Durable Acceptance:**
   - *Architectural Conflict:* Relay's primary durability promise is that notifications are accepted into PostgreSQL (`notifications` and `outbox_events`) before queueing. If Redis failure caused the API to reject requests (fail-closed), Redis would become an accidental single point of failure for durable ingestion.
   - *Decision:* The rate limiter operates **fail-open** when Redis is unavailable or unresponsive:
     - All Redis operations are wrapped in bounded timeouts (`RATE_LIMIT_TIMEOUT_MS`, default 500ms) via `Promise.race()`.
     - When Redis times out or throws an error (`ECONNREFUSED`), the rate limiter immediately grants access (`allowed: true, failOpen: true`) and allows durable ingestion into PostgreSQL to proceed.
     - Telemetry records the failure (`relay_rate_limit_redis_failures_total`) and throttles log warnings to at most one per 30 seconds.

5. **Standardized HTTP Response Headers:**
   - The API returns standard `RateLimit-Limit`, `RateLimit-Remaining`, and `RateLimit-Reset` headers on all ingestion responses.
   - When quota is exhausted, the API returns `HTTP 429 Too Many Requests` with a standard `Retry-After` header and a clean JSON error response (`code: "RATE_LIMIT_EXCEEDED"`). Internal Redis keys and implementation details are never exposed to clients.

6. **Label Safety in Prometheus Telemetry:**
   - `relay_rate_limit_evaluations_total` uses a static label `result` (`allowed`, `rate_limited`, `fail_open`).
   - Tenant IDs (`customerId`) are strictly forbidden from Prometheus metric labels to prevent label cardinality explosion.

### 9.3 Test Verification & Matrix
The test suite in `tests/rateLimiter.test.ts` (11 automated tests) verifies:
- Quota enforcement within limit (HTTP 202) and beyond limit (HTTP 429).
- Tenant isolation: Tenant A exhausting quota does not affect Tenant B.
- Concurrency safety: Concurrent requests against the same tenant are handled atomically.
- Cross-instance state sharing: Multiple simulated API instances share rate limit state via Redis.
- Window expiration: Quota automatically resets after the 60-second window elapses.
- Idempotency refund: Safe replays restore quota; conflicting replays retain quota.
- Fail-open resilience: Redis unavailability allows ingestion and increments metric counters.
- Bounded timeout: Slow/hanging Redis calls fail open within 50ms without hanging the request.
- Prometheus metrics: Correctly tracks evaluations, latency histograms, and Redis failures.

Full test suite verification: **7 test files, 40 tests passing**.

### 9.4 Remaining Limitations & Future Work
- **Static Configuration:** Quotas are currently configured globally via environment variables (`RATE_LIMIT_MAX_REQUESTS=100`, `RATE_LIMIT_WINDOW_SECONDS=60`). Future milestones should support dynamic per-tenant tiering (e.g. Free vs Pro vs Enterprise) loaded from a customer database or cache.
- **Fail-Open Abuse Window:** In a prolonged Redis outage, rate limits are temporarily unenforced. A production system might introduce a local in-memory fallback rate limiter (LRU cache) to cap traffic per node during Redis downtime.

---

## 10. Milestone 6C: Tenant-Aware Fair Scheduling (29 October 2026)

### 10.1 Problem Analysis: Dual-Stage Head-of-Line Blocking
Prior to Milestone 6C, Relay suffered from a compound multi-tenant fairness defect: **Dual-Stage Head-of-Line (HoL) Blocking**:
1. **Database Outbox Claiming:** The Outbox Dispatcher claimed unpublished events via a global `ORDER BY created_at ASC LIMIT 10`. When a high-volume tenant (Tenant A) enqueued 1,000 notifications, its records monopolized the outbox dispatcher batches for 100 consecutive polling cycles, completely blocking latency-sensitive notifications from low-volume tenants (Tenants B & C) from even being published to Redis.
2. **Worker Queue Consumption:** Even after events reached BullMQ, the single global channel queues (`email-notifications`, `sms-notifications`) processed jobs in global FIFO order. High-volume tenants saturated all available worker concurrency slots (`WORKER_CONCURRENCY`), delaying low-volume tenants.

### 10.2 Algorithm Evaluation & Design Selection
We evaluated four architectural alternatives:
- **One BullMQ Queue Per Tenant:** Rejected because in a multi-tenant system with thousands of customers, creating permanent queues creates severe Redis memory overhead, idle queue polling storms, and complex queue lifecycle management.
- **Weighted Fair Queuing (WFQ):** Rejected due to the excessive state bookkeeping and locking required to maintain virtual finish timestamps across distributed Node.js processes.
- **Deficit Round-Robin (DRR):** Impractical to maintain across multiple stateless dispatcher and worker daemons without an orchestrator holding cluster-wide state.
- **Relay's Selected Solution: Dual-Stage Fairness Architecture:**
  - **Stage 1: Outbox Interleaved Round-Robin (IRR) Claiming:** Using a SQL Window Function `ROW_NUMBER() OVER (PARTITION BY n.customer_id ORDER BY oe.created_at ASC) as tenant_turn` and sorting by `tenant_turn ASC, created_at ASC LIMIT $1`, the database automatically claims 1 item per active tenant in a round-robin rotation (`A1, B1, C1, A2, B2, C2...`).
  - **Stage 2: Distributed Dynamic Tenant Concurrency Control (DTCC):** Workers invoke an atomic Redis Lua script (`acquireSlot`) before executing. Each tenant is capped at `TENANT_MAX_CONCURRENT_JOBS` (default 2) when other tenants are active. If a tenant exceeds quota under contention, the worker defers the job non-destructively via `job.moveToDelayed(Date.now() + 500, token); throw new DelayedError()`.
  - **Work-Conserving Burst:** When only one tenant is active in the cluster, the Lua script automatically allows that sole tenant to burst up to 100% of worker capacity (`WORKER_CONCURRENCY`), preventing idle infrastructure waste.

### 10.3 Engineering Lessons & Bugs Resolved
During implementation and stress verification, several subtle distributed systems issues were identified and resolved:
1. **Dispatcher Overlap Guard (`isDispatching`):**
   - *Problem:* When running benchmarks or fast polling intervals (`pollIntervalMs = 100ms`), long-running database queries overlapped with subsequent timer ticks, piling up dozens of concurrent `dispatch()` executions and exhausting the PostgreSQL connection pool.
   - *Fix:* Added an `isDispatching` boolean guard to ensure a subsequent dispatch cycle only runs after the previous cycle has completely finished. Furthermore, `stop()` was updated to await any in-flight dispatch execution before resolving, preventing pool closure errors during teardown.
2. **Database Connection Pool Exhaustion & Neon Sizing (`max: 5` -> Configurable `DB_POOL_MAX`):**
   - *Problem:* `src/database/pool.ts` originally hardcoded `max: 5` connections. With 5 concurrent worker threads plus the dispatcher, threads deadlocked waiting for available clients during multi-tenant bursts. In addition, idle socket resets from Neon cloud PostgreSQL triggered unhandled process errors.
   - *Fix:* Made pool size configurable via `env.DB_POOL_MAX` (default: 15) and registered `pool.on("error")` to swallow transient idle connection drops. With Neon's PgBouncer transaction pooler (`-pooler` endpoint), 15 connections per process scales safely without exhausting serverless session limits.
3. **Double Client Release in Dispatcher:**
   - *Problem:* `client.release()` was called immediately after `COMMIT` in `dispatch()`, but was also called unconditionally in the outer `finally` block, throwing `Release called on client which has already been released to the pool`.
   - *Fix:* Introduced `let clientReleased = false;` to guarantee that the client connection is released at most once and never double-released.
4. **Subquery Window Truncation Bug (`LIMIT 500`):**
   - *Problem:* An initial draft of the outbox SQL query included `LIMIT 500` inside the subquery before the window function. When Tenant A inserted 1,000 items, the inner `LIMIT 500` selected only Tenant A's items, completely cutting off Tenants B and C from the window partitioning!
   - *Fix:* Removed the inner `LIMIT 500`, allowing the window function to partition across all pending items and interleave all active tenants.
5. **Worker Crash Capacity Recovery & Counter Drift (Self-Healing Lua):**
   - *Problem:* If a worker process crashed without calling `releaseSlot()`, its Redis tenant key would expire after 60s, but its customer ID remained in `active_tenants` and `total_active` remained incremented, permanently impairing future bursting calculations.
   - *Fix:* Enhanced `acquireSlot` Lua script with a self-healing audit loop. On every slot request, it audits members of `active_tenants`. Any member with 0 active jobs (`SCARD == 0`) is purged from `active_tenants`, and `total_active` is resynchronized to the sum of actual active job sets.

### 10.4 Empirical Benchmark Verification
We evaluated tenant fairness across two benchmark configurations:

1. **Large-Scale Asymmetric Stress Test (1,100 notifications):**
   - *Workload:* Tenant A (1,000 items), Tenant B (50 items), Tenant C (50 items).
   - *Measured Empirical Results:*
     - Tenant B achieved 100% completion (50/50) in **89.4 seconds**.
     - Tenant C achieved 100% completion (50/50) in **94.1 seconds**.
     - Tenant A had completed 117 of its 1,000 items when Tenants B and C finished.
     - *Clarification:* Total run was halted at ~300+ items by a cloud TCP reset; full 1,100 terminal state was not completed during that specific run. The ~15-minute wait comparison was a theoretical mathematical estimate (`1,000 items / ~1.1 items/s = ~900s`), not a measured FIFO execution.
2. **Bounded Complete Terminal Verification Test (60 notifications):**
   - *Workload:* Tenant A (40 items), Tenant B (10 items), Tenant C (10 items).
   - *Measured Empirical Results (Direct PostgreSQL Database Audit):*
     - **100.0% Terminal State:** All 60 notifications reached `processed` in PostgreSQL (`A: 40/40, B: 10/10, C: 10/10`).
     - **Outbox Publication:** 60/60 (100%) outbox events published to BullMQ.
     - **Tenant B (10 items):** First completed in 8.78s; 100% completed in **33.70s**.
     - **Tenant C (10 items):** First completed in 14.90s; 100% completed in **37.27s**.
     - **Tenant A (40 items):** 100% completed in **55.64s**.
     - **Tenant A Progress at Low-Volume Completion:** Tenant A was at exactly 20/40 (50.0%) when Tenants B and C finished.
     - **FIFO Comparison:** The measured fairness benchmark showed low-volume tenants completing before the high-volume tenant. The FIFO comparison is theoretical and was not independently benchmarked.

### 10.5 Remaining Limitations
- **Dynamic Tiered Quotas:** All tenants currently share the same static concurrency limit (`TENANT_MAX_CONCURRENT_JOBS=2`). Production systems should support dynamic limits based on customer subscription tiers (e.g. Free: 2, Pro: 10, Enterprise: 50).
- **Waiting vs Slot-Holding Contention Window:** Bursting eligibility checks currently active slot holders. Interleaved outbox batching bounds waiting queues, but pure queue-depth-aware fairness would require tracking waiting tenant sets.
- **Ingress Backpressure (Milestone 6D):** Fairness currently balances work already accepted into the outbox. When the outbox backlog grows beyond safe operational thresholds, ingestion at `POST /v1/notifications` must apply backpressure.

---

## 11. Milestone 6D: Backpressure and Overload Protection (29 October 2026)

### 11.1 Problem Statement: Protecting the Acceptance Guarantee
Prior to Milestone 6D, Relay offered durable acceptance via PostgreSQL and fair processing across tenants, but had no mechanism to reject traffic when upstream volume exceeded cluster processing capacity. Under extreme surges or downstream dependency stalls:
1. **Unbounded Outbox Growth:** If workers or third-party email/SMS gateways stalled, `POST /v1/notifications` would continuously accept requests with HTTP 202, filling PostgreSQL tables until disk exhaustion.
2. **Database Connection Starvation:** Heavy ingestion concurrent with worker processing exhausted pool connections, causing cascading 500 errors across all routes.
3. **Queue Flooding:** The Outbox Dispatcher claimed events without checking downstream BullMQ queue depth, risking Redis memory exhaustion.

Milestone 6D introduced comprehensive admission control, multi-tier backpressure, and overload protection to guarantee that Relay never accepts a notification it cannot safely store and deliver.

### 11.2 Engineering Trade-offs & Implementation Decisions

#### 1. Rate Limiting Before Backpressure Pre-Screening
- *Challenge:* If admission control runs before rate limiting, a malicious tenant could flood the server with requests during an outage or overload state, consuming server evaluation resources without being rate limited.
- *Decision:* Evaluate rate limiting first. If a tenant exceeds 100 req/60s, they receive HTTP 429 immediately. When an admission request is subsequently rejected due to system overload (HTTP 503), Relay immediately issues an atomic quota refund (`rateLimiter.refund(customerId, member)`). This ensures innocent tenants are never penalized for server-side overload.

#### 2. Safe Idempotency Replays During Overload
- *Challenge:* If a client submits a request, succeeds with HTTP 202, but experiences a client-side network glitch before receiving the response, it will retry the identical request with the same `Idempotency-Key`. If Relay blindly returned HTTP 503 during overload, the client would wrongly assume the notification was not accepted and trigger alerting or unnecessary retries.
- *Decision:* Relay executes a read-only idempotency lookup (`findReadOnly`) during `OVERLOADED` state without starting a database write transaction. If the payload hash matches the existing record, Relay returns HTTP 202 with the original notification (`isReplay: true`) and zero new outbox rows. If the payload hash differs, it returns HTTP 409 `IDEMPOTENCY_CONFLICT`. Only truly new submissions receive HTTP 503 `SYSTEM_OVERLOADED`.

#### 3. Caching Heavy Backlog Evaluations (`BACKPRESSURE_CACHE_TTL_MS`)
- *Challenge:* Running `SELECT COUNT(*) FROM outbox_events WHERE published_at IS NULL` on every incoming HTTP request would add intolerable query load to PostgreSQL during high-traffic spikes.
- *Decision:* The `BackpressureService` caches state calculations for `BACKPRESSURE_CACHE_TTL_MS` (default: 1,000ms). When multiple concurrent requests arrive, only one lightweight cache read is performed.

#### 4. Temporary Redis Outage vs Prolonged Outage
- *Challenge:* Should Relay reject requests as soon as Redis disconnects?
- *Decision:* No. Relay's core architectural advantage is the transactional outbox: PostgreSQL accepts notifications independently of Redis. During a temporary Redis outage, Relay transitions to `DEGRADED` (not `OVERLOADED`), setting `x-backpressure-state: DEGRADED` and continuing to accept notifications into PostgreSQL. Only if Redis remains offline so long that the outbox backlog exceeds `BACKPRESSURE_OUTBOX_OVERLOAD_THRESHOLD` (2,000 items) does the system transition to `OVERLOADED` to protect database storage.

### 11.3 Empirical Failure Drill Verification (`npm run drill`)
A dedicated, repeatable failure drill was created in `scripts/failureDrill.ts` and executed against the live Neon cloud PostgreSQL database and local Redis instance:

- **Phase 1: Baseline Normal Ingress:**
  - Ingested 5 notifications under `NORMAL` conditions.
  - All 5 returned HTTP 202 Accepted.
  - Confirmed 5 outbox events were created and published.
- **Phase 2: Simulated Redis Outage (DEGRADED Ingress):**
  - Disconnected Redis while PostgreSQL remained healthy.
  - System transitioned to `DEGRADED` (`reason: redis_unavailable`).
  - Ingested 5 notifications: 100% accepted with HTTP 202 and `x-backpressure-state: DEGRADED`.
  - Confirmed all 5 notifications were durably persisted in PostgreSQL.
- **Phase 3: Outbox Backlog Surcharge (OVERLOADED Admission Defense):**
  - Simulated prolonged outage where outbox backlog crossed threshold.
  - System transitioned to `OVERLOADED` (`reason: outbox_backlog`).
  - Sent new submissions: Cleanly rejected with HTTP 503 `SYSTEM_OVERLOADED` and `Retry-After: 10`.
  - Sent duplicate identical replay: Successfully returned HTTP 202 with `isReplay: true` (zero outbox events created).
  - Sent duplicate conflicting replay: Cleanly rejected with HTTP 409 `IDEMPOTENCY_CONFLICT`.
  - Confirmed zero rows were added to `notifications` or `outbox_events` after 503 rejections.
- **Phase 4: Recovery & Drain Verification:**
  - Restored Redis and cleared overload conditions.
  - System transitioned back to `NORMAL`.
  - Outbox Dispatcher claimed and published all accumulated events to BullMQ.
  - Workers drained all notifications to `processed` status.

### 11.4 Empirical Load Test Verification (`npm run load-test`)
A reproducible multi-tenant load test was executed in `scripts/loadTest.ts` to measure real-world performance under concurrency:

- **Workload:** 70 total requests across two tenants (Tenant A and Tenant B) with concurrent batching.
- **Initial Run Observations & Root Cause Analysis:**
  - *Observation:* During the initial baseline run, 49/50 requests were accepted with HTTP 202, while 1 request was rejected with HTTP 503.
  - *Exact Error:* `[BackpressureService] PostgreSQL check failed: Database check timeout`
  - *Root Cause:* In `BackpressureService.evaluateState()`, the database backlog query was wrapped in an aggressive 1,000ms `Promise.race` timeout. Under concurrent connection acquisition against AWS Neon cloud PostgreSQL in London, a single query round-trip took ~1,050ms. This timed out, causing `dbHealthy = false` and transitioning the state to `OVERLOADED (Reason: db_health)`. The next incoming request checked admission before starting a database transaction and was cleanly rejected at the routing layer with HTTP 503. One second later (`BACKPRESSURE_CACHE_TTL_MS = 1000`), the cache expired, the next probe succeeded, and the engine recovered to `NORMAL`.
  - *Resolution:* Increased the database probe timeout from 1,000ms to 2,500ms and introduced failure damping requiring 2 consecutive probe failures before marking `dbHealthy = false`.
- **Repeat Baseline Load Test (Post-Fix Verification):**
  - **HTTP 202 Accepted: 50 / 50 (100.0%)**
  - **HTTP 429 Rate-Limited: 0**
  - **HTTP 503 Overloaded: 0 (Zero unexpected 503 rejections)**
  - Ingress Duration: 12.64 seconds
  - Measured Ingress Rate: 4.0 req/s
  - API Latency P50: 1,086 ms
  - API Latency P95: 2,826 ms
  - API Latency P99: 2,827 ms
- **Phase 2: Overload Admission Defense & Rejection Latency (20 requests):**
  - Admission Defense: 100% (20/20) cleanly rejected with HTTP 503.
  - **Rejection Latency P50: 136 ms** (an 87.5% latency reduction compared to baseline 1,086ms, demonstrating zero DB transaction write overhead during overload).
  - Rejection Latency P95: 149 ms.
- **Phase 3: Worker Draining Throughput:**
  - Initial Outbox Backlog: 50 items.
  - Backlog drained to 0 in 45.16 seconds.
  - Worker Drain Rate: 1.1 notifications/second (simulating full network round-trips for email delivery).

### 11.5 Automated Regression Suite
All 67 automated tests passed cleanly across 9 test suites:
- `tests/backpressure.test.ts` (15/15 passed)
- `tests/fairness.test.ts` (12/12 passed)
- `tests/rateLimiter.test.ts` (11/11 passed)
- `tests/metrics.test.ts` (9/9 passed)
- `tests/notifications.test.ts` (8/8 passed)
- `tests/outbox.test.ts` (4/4 passed)
- `tests/reconciliation.test.ts` (3/3 passed)
- `tests/readiness.test.ts` (3/3 passed)
- `tests/health.test.ts` (2/2 passed)

### 11.6 Lessons Learned & Production Considerations
1. **Fast-Path Rejections Save Infrastructure:** During overload, taking a write transaction or waiting for DB locks creates death spirals. Rejecting requests at the HTTP routing boundary in 136ms protects the database from collapsing.
2. **Replay Preservation is Mandatory:** Without read-only idempotency checks, clients retrying identical notifications during an outage receive 503s, leading them to resubmit under different keys later, creating duplicate messages.
3. **Rate Limit Refund Atomicity:** When refunding rate limit quota on HTTP 503 rejection or safe replay, `rateLimiter.refund()` executes `ZREM` using a globally unique member token `${now}:${crypto.randomUUID()}` generated at consumption time. This ensures that refunds cannot accidentally refund another concurrent request's quota.
4. **Dispatcher Queue Depth Capping Must Account for Delayed Jobs:** When fair scheduling defers a job under multi-tenant contention, it moves the job into BullMQ's `delayed` state for 500ms. Outbox dispatcher queue depth calculation must inspect `(waiting + delayed)`, not just `waiting`, to prevent flooding Redis when dozens of jobs are in a delayed backoff state.
5. **State Caching & Bounded Ingress Overshoot:** Backpressure state caching (`BACKPRESSURE_CACHE_TTL_MS = 1000ms`) bounds the maximum theoretical backlog overshoot to $\text{Overshoot}_{\text{max}} = R_{\text{ingress}} \times 1.0\text{s}$ (~5–50 items for prototype concurrency). This trade-off is essential to eliminate full-table count storms on every API request.
6. **Remaining Production Limitations:**
   - *Static vs Dynamic Thresholds:* Current thresholds (500 degraded, 2000 overloaded) are fixed in environment variables. Production systems with autoscaling worker pools should scale thresholds proportionally with active worker count.
   - *Outbox Table Partitioning:* At 50M notifications/day, `outbox_events` requires daily partitioning so that backlog queries scan only the active partition index.
   - *Outbox Table Partitioning:* At 50M notifications/day, `outbox_events` requires daily partitioning so that backlog queries scan only the active partition index.



