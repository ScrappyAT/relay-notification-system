# Relay — Technical Interview Preparation & Architecture Defense

**Project:** Relay Multi-Tenant Notification Infrastructure  
**Audience:** Technical Interviewers, Architecture Reviewers, and Hiring Committees  
**Author:** Graduate Candidate  

---

## 1. Why PostgreSQL and Redis together? Why not just one of them?

### Concise Answer
PostgreSQL provides ACID transactions, durable persistence, relational integrity, and row-level locking (`FOR UPDATE SKIP LOCKED`), making it the ideal system of record for the **Transactional Outbox pattern** and durable acceptance guarantees. Redis provides sub-millisecond atomic memory operations (via custom Lua scripts) and distributed FIFO/delayed queue structures (via BullMQ), making it the ideal engine for **sliding-window rate limiting, tenant fairness concurrency slots, and high-throughput job queueing**.

### Technical Trade-off
- **Using PostgreSQL Alone for Queuing:** While possible with `SKIP LOCKED`, polling PostgreSQL at 50,000 queries per second for queue pops causes severe table bloat, write amplification, and connection pool exhaustion.
- **Using Redis Alone for Ingestion:** Redis lacks multi-table ACID transactions, foreign keys, and durable relational constraints. If Redis runs out of memory or a node fails before replica sync, messages accepted via HTTP would be lost, violating our durable acceptance guarantee.

---

## 2. Why use a Transactional Outbox pattern instead of publishing directly to Redis in the HTTP handler?

### Concise Answer
Publishing directly to a message broker inside an HTTP request handler creates the **distributed dual-write problem**. If the database transaction commits but the subsequent Redis publish fails (network glitch, Redis crash), the notification is accepted by the client but never sent (silent message loss). Conversely, if the message is published to Redis but the database transaction rolls back, the notification is sent without any persistent database record.

### How Relay Solves This
Relay writes the notification record, outbox event, and idempotency key within a **single atomic PostgreSQL transaction**. If the transaction commits, both records are guaranteed to exist on disk. A decoupled background daemon ([`OutboxDispatcher`](file:///c:/Users/HP/Desktop/relay-system/src/services/outboxDispatcher.ts)) polls unpublished outbox events and pushes them to Redis asynchronously.

---

## 3. Why does Relay guarantee at-least-once delivery instead of exactly-once delivery?

### Concise Answer
In distributed systems, **exactly-once delivery across network boundaries is impossible** without two-phase commit (2PC) or downstream recipient-level deduplication (end-to-end argument).

### Detailed Breakdown
If a worker successfully delivers an email to an upstream provider (e.g., SendGrid) but crashes or suffers a network timeout before it can update PostgreSQL (`status = 'processed'`), the lease reconciliation daemon will detect an expired lease and re-dispatch the job. The retry will cause a second delivery attempt. Relay achieves **effective deduplication** at the ingestion and dispatch boundaries via deterministic job IDs (`notif-{id}`) and database idempotency keys, but end-delivery to third-party networks remains fundamentally **at-least-once**.

---

## 4. What happens when Redis goes down? How does Relay recover?

### Concise Answer
Relay decouples ingestion availability from Redis availability. If Redis crashes or experiences a network partition:

1. **Ingestion Continues in DEGRADED State:** The API checks PostgreSQL health. Because PostgreSQL is healthy, Relay transitions to `DEGRADED`, setting the `x-backpressure-state: DEGRADED` header. Notifications continue to be accepted with `HTTP 202 Accepted` into PostgreSQL via the transactional outbox.
2. **Rate Limiting Fails Open:** The rate limiter logs a throttled warning and fails open (`allowed: true, failOpen: true`) to preserve durable acceptance.
3. **Dispatcher Traps Errors Gracefully:** The Outbox Dispatcher catches Redis connection errors (`ECONNREFUSED`), releases claimed locks, and backs off without crashing.
4. **Prolonged Outage Defense:** If Redis remains down so long that outbox events accumulate past `BACKPRESSURE_OUTBOX_OVERLOAD_THRESHOLD` (2,000 items), Relay transitions to `OVERLOADED` and rejects further submissions with `HTTP 503` to protect PostgreSQL storage.
5. **Automatic Recovery:** When Redis reconnects, the dispatcher resumes claiming and workers drain the accumulated backlog to `processed` status.

---

## 5. How does Relay's idempotency mechanism work? How does it handle concurrent identical requests?

### Concise Answer
Relay enforces tenant-scoped idempotency via a unique composite database constraint on `idempotency_keys(customer_id, idempotency_key)` storing a SHA-256 hash of the canonical request body:

1. **Sequential Identical Request:** If an existing key matches and `request_hash` matches, Relay returns the previously committed record with `HTTP 202 Accepted` (`isReplay: true`) with zero new outbox rows.
2. **Conflicting Request:** If the key exists but the payload hash differs, Relay returns `HTTP 409 Conflict` (`IDEMPOTENCY_CONFLICT`).
3. **Concurrent Submissions:** Two concurrent requests race to insert into `idempotency_keys`. One transaction wins and commits. The losing transaction catches PostgreSQL error code `23505` (unique violation), rolls back, and reads the winner's committed record, returning `HTTP 202` without duplicate processing.

---

## 6. How do you prevent one high-volume tenant from monopolizing workers (Head-of-Line Blocking)?

### Concise Answer
Relay implements a **Dual-Stage Tenant Fairness Architecture**:

1. **Stage 1 (Outbox Interleaved Round-Robin):** In PostgreSQL, the dispatcher queries unpublished outbox events using a window function:
   ```sql
   ROW_NUMBER() OVER (PARTITION BY n.customer_id ORDER BY oe.created_at ASC) as tenant_turn
   ```
   Sorting by `tenant_turn ASC, created_at ASC` claims 1 event per active tenant per cycle (`A1, B1, C1, A2, B2, C2...`).
2. **Stage 2 (Distributed Dynamic Tenant Concurrency Control):** Before executing, workers invoke an atomic Redis Lua script (`acquireSlot`). Under multi-tenant contention, each tenant is capped at `TENANT_MAX_CONCURRENT_JOBS = 2` concurrent worker slots.
3. **Work-Conserving Bursting:** When only one tenant has pending work, the Lua script allows it to burst up to 100% of worker capacity (`WORKER_CONCURRENCY = 5`), preventing idle infrastructure. Bursting is immediately revoked when a second tenant claims execution.

---

## 7. How does Relay defer jobs under tenant contention without burning retries?

### Concise Answer
When a worker calls `acquireSlot` and is denied because the tenant is already executing 2 concurrent jobs, the worker does **not** fail the job or throw a generic error.

Instead, Relay uses BullMQ's native `DelayedError`:
```typescript
const slot = await tenantFairnessService.acquireSlot("email", customerId, jobId);
if (!slot.granted) {
  await job.moveToDelayed(Date.now() + 500, token);
  throw new DelayedError();
}
```
`moveToDelayed` places the job into BullMQ's `delayed` set with a 500ms backoff. BullMQ pauses the job without incrementing the job's failure counter or consuming retries, immediately releasing the worker thread to pick up waiting jobs from other tenants.

---

## 8. How does Relay's backpressure and admission control work?

### Concise Answer
Relay uses a three-state hierarchical engine evaluated by [`BackpressureService`](file:///c:/Users/HP/Desktop/relay-system/src/services/backpressureService.ts):
- **`NORMAL`:** Accepts all valid requests with `HTTP 202`.
- **`DEGRADED`:** Accepts requests with `HTTP 202` and `x-backpressure-state: DEGRADED` when outbox backlog $\ge 500$, queue backlog $\ge 1,000$, or Redis is down.
- **`OVERLOADED`:** Rejects new submissions with `HTTP 503 SYSTEM_OVERLOADED` and `Retry-After: 10` when outbox backlog $\ge 2,000$, queue backlog $\ge 5,000$, or PostgreSQL is unhealthy.

### Fast-Path Rejection Performance
Under `OVERLOADED`, rejections execute at the HTTP router before taking a database transaction or connection lock. In our empirical load tests, HTTP 503 rejection latency was **136ms P50 vs 1,086ms P50 baseline**, protecting the database from collapsing under load.

---

## 9. Why evaluate rate limits before backpressure admission control?

### Concise Answer
Evaluating rate limiting first prevents denial-of-service amplification:
- If admission control ran before rate limiting, a malicious tenant could flood the server with millions of fake requests during an overload or outage state, forcing the server to evaluate database backlogs without being throttled.
- By placing the Redis sliding-window check first, unauthenticated tenant flooding is immediately rejected with `HTTP 429 Too Many Requests`.
- To ensure fairness to legitimate tenants, if a request passes rate limiting but is subsequently rejected with `HTTP 503` due to system overload, Relay **atomically refunds the consumed rate limit token** via `rateLimiter.refund(customerId, member)`.

---

## 10. How does the rate-limit refund work atomically without race conditions?

### Concise Answer
In [`RateLimiter.consume()`](file:///c:/Users/HP/Desktop/relay-system/src/services/rateLimiter.ts), when a request token is recorded in the Redis Sorted Set (`rl:tenant:{customerId}`), the member string is constructed with a millisecond timestamp and a cryptographically random UUID:
```typescript
const member = `${now}:${crypto.randomUUID()}`;
```
When `rateLimiter.refund(customerId, member)` is invoked on `HTTP 503` or safe replay, it calls `ZREM key member`. Because `member` contains a unique UUID, `ZREM` removes **only that exact request's token**. It is mathematically impossible for a refund to remove or interfere with a concurrent request from the same or different tenants.

---

## 11. Can cached backpressure state permit excessive admissions? What is the maximum expected overshoot?

### Concise Answer
Yes, state caching permits a bounded ingress overshoot, but it is mathematically controlled and intentionally designed:
- **Formula:** $\text{Overshoot}_{\text{max}} = R_{\text{ingress}} \times T_{\text{cache\_ttl}}$
- With `BACKPRESSURE_CACHE_TTL_MS = 1000ms` (1.0s) and prototype ingress rates of 5–50 req/s, the maximum potential overshoot beyond the 2,000-item threshold is **5–50 notifications**.
- **Why this is acceptable:** The 2,000 threshold is an operational buffer, not a catastrophic cliff. PostgreSQL easily absorbs an extra 50 rows in the outbox. Without caching, executing `SELECT COUNT(*)` on every API request would saturate the database connection pool during a traffic surge, creating self-inflicted downtime.

---

## 12. How do you prevent multiple concurrent outbox dispatchers from claiming the same event?

### Concise Answer
Relay uses PostgreSQL row-level locking with `FOR UPDATE SKIP LOCKED`:
1. When a dispatcher queries unpublished outbox events, it wraps the query in `FOR UPDATE SKIP LOCKED` inside a transaction.
2. PostgreSQL locks the matching rows for that dispatcher's transaction. Any concurrent dispatcher running simultaneously automatically skips the locked rows and claims the next available batch.
3. The claiming transaction updates `locked_until = NOW() + leaseDurationSeconds` and `attempts = attempts + 1`, and commits.
4. BullMQ also enqueues jobs with deterministic job IDs (`notif-{id}`), providing a secondary deduplication safeguard if an outbox lease ever expired prematurely.

---

## 13. How does the reconciliation service detect and recover from worker crashes?

### Concise Answer
When a worker starts processing a notification, it writes a lease lock to PostgreSQL (`processing_locked_until = NOW() + 60s`).
- If the worker process crashes or the container is terminated mid-execution, `processing_locked_until` expires.
- The standalone [`ReconciliationService`](file:///c:/Users/HP/Desktop/relay-system/src/services/reconciliationService.ts) periodically runs:
  ```sql
  SELECT * FROM notifications 
  WHERE status = 'processing' AND processing_locked_until < NOW()
  FOR UPDATE SKIP LOCKED;
  ```
- If `retry_count < 3`: It clears the expired lease, resets `status = 'pending'`, increments `retry_count`, and emits a new outbox event for re-dispatch.
- If `retry_count >= 3`: It marks `status = 'failed'` with an audit error message.

---

## 14. How do you prevent Prometheus metrics from causing memory leaks (Cardinality Explosion)?

### Concise Answer
By enforcing a strict **Bounded Label Invariant**:
- Dynamic high-cardinality attributes—specifically **customer UUIDs (`customerId`), notification IDs, recipient addresses, and idempotency keys—are strictly forbidden as Prometheus labels**.
- All Prometheus metrics in Relay use low-cardinality static enums:
  - `channel`: `email`, `sms` (cardinality: 2)
  - `status`: `pending`, `processing`, `processed`, `failed` (cardinality: 4)
  - `state`: `NORMAL`, `DEGRADED`, `OVERLOADED` (cardinality: 3)
  - `reason`: `outbox_backlog`, `queue_backlog`, `db_health`, `manual_override` (cardinality: 4)
- Tenant fairness is observed in aggregate via gauges (`relay_active_tenants`), histograms (`relay_tenant_scheduling_delay_seconds`), and counters (`relay_fair_scheduling_decisions_total{decision="burst|deferred"}`).

---

## 15. Why is 50 million notifications/day not yet proven on this prototype, and what would need to change for production?

### Concise Answer
Relay was architected around the *design constraints* of a 50M notifications/day system (~580 req/s continuous, ~2,500 req/s peak), but the bootcamp prototype was verified at **4.0 req/s ingress** against a single serverless AWS Neon PostgreSQL instance and local Redis.

### Production Architectural Changes Required:
1. **Table Partitioning:** At 50M/day, `outbox_events` and `notifications` accumulate 1.5 billion rows per month. They must be partitioned daily (`notifications_YYYY_MM_DD`) so that index lookups and count queries scan only the active partition.
2. **Read Replica Offloading:** Safe read-only idempotency checks (`findReadOnly`) during overload should be routed to PostgreSQL read replicas.
3. **Distributed Rate Limiting Cluster:** Scale Redis to a Redis Cluster or Redis Enterprise with cluster-aware Lua script sharding by customer ID hash tags (`rl:tenant:{customerId}`).
4. **Autoscaled Worker Fleets:** Deploy worker pools on Kubernetes with KEDA (Kubernetes Event-driven Autoscaling) scaling worker pods dynamically based on BullMQ queue depth.
5. **Real Gateway Webhooks:** Replace delivery simulation with Twilio/SendGrid APIs, handling webhook delivery receipts and provider rate limits.

