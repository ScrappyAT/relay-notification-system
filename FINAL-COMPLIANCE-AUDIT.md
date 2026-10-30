# Relay — Final Technical Compliance Audit (Reconciled from Source Artifacts)

**Project:** Relay Notification Infrastructure Prototype
**Candidate:** Graduate Candidate
**Repository:** `ScrappyAT/relay-notification-system`
**Working Directory:** `c:\Users\HP\Desktop\relay-system`
**Date of Audit:** 30 October 2026
**Auditor:** Technical Verification Agent

---

## Executive Summary & Submission Status

This compliance audit evaluates the Relay codebase against Part 3 of the Dev and Design HQ Final Graduation Task. All metrics, costs, pool configurations, and code claims have been reconciled directly against actual source files, test runs, database configurations, and saved benchmark artifacts.

### Graduation Deliverables Status

| Deliverable | Graduation Task Requirement | Status | Evidence & Source Artifacts |
| :--- | :--- | :---: | :--- |
| **Deliverable 1: Design Document** | Complete 12-section technical architecture document | **COMPLETE** | [`DESIGN.md`](file:///c:/Users/HP/Desktop/relay-system/DESIGN.md) (All 12 required sections present and passing) |
| **Deliverable 2: Working Prototype** | Functional Node.js/TypeScript prototype meeting all 12 criteria | **COMPLETE** | [`src/`](file:///c:/Users/HP/Desktop/relay-system/src), [`tests/`](file:///c:/Users/HP/Desktop/relay-system/tests) (95/95 passing automated tests across 11 test files) |
| **Deliverable 3: 20-min Walkthrough Video** | Recorded screen walkthrough of architecture, code, and terminal demo | **PENDING** | Postponed; to be recorded in dedicated presentation session |
| **Deliverable 4: Mock Technical Interview** | Interactive oral defense answering deep-dive architecture questions | **PENDING** | Postponed; scheduled for live evaluation per [`INTERVIEW-PREP.md`](file:///c:/Users/HP/Desktop/relay-system/INTERVIEW-PREP.md) |
| **OVERALL GRADUATION SUBMISSION** | All four graduation deliverables submitted | **NOT YET COMPLETE** | Deliverables 1 & 2 complete; Deliverables 3 & 4 pending presentation |

> [!NOTE]
> **Graduation Task PDF Notice:**
> A workspace search (`Get-ChildItem -Path . -Filter "*.pdf" -Recurse`) confirmed that no original PDF file is present in the repository root or subdirectories. This audit was executed strictly against the graduation task specification criteria provided in the prompt.

---

## 1. Corrected k6 Load-Testing Metrics

The load test results below are extracted directly from the raw k6 summary files ([`benchmarks/k6/summary-baseline.json`](file:///c:/Users/HP/Desktop/relay-system/benchmarks/k6/summary-baseline.json), [`benchmarks/k6/summary-ramp_up.json`](file:///c:/Users/HP/Desktop/relay-system/benchmarks/k6/summary-ramp_up.json), [`benchmarks/k6/summary-spike.json`](file:///c:/Users/HP/Desktop/relay-system/benchmarks/k6/summary-spike.json)) and reconciled with [`benchmarks/k6/REPORT.md`](file:///c:/Users/HP/Desktop/relay-system/benchmarks/k6/REPORT.md).

### Itemized Scenario Breakdown

| Response Classification | Scenario A (Baseline) | Scenario B (Ramp-Up / Noisy Tenant) | Scenario C (Short Overload Spike) | Aggregate (All Scenarios) |
| :--- | :---: | :---: | :---: | :---: |
| **Duration (Wall-Clock)** | 21.17 s | 52.59 s | 31.15 s | 104.91 s |
| **Target Concurrency** | 3 constant VUs | 2 → 35 VUs (4 stages) | 5 → 30 → 5 VUs | Max 35 VUs |
| **Total HTTP Requests Attempted** | **36** (100.0%) | **1,490** (100.0%) | **727** (100.0%) | **2,253** (100.0%) |
| ├── **HTTP 202 Accepted** (Durable Ingress) | 36 (100.0%) | 217 (14.56%) | 103 (14.17%) | **356** (15.80%) |
| ├── **HTTP 200 Suppressed** (Preference Opt-Out) | 0 (0.00%) | 17 (1.14%) | 9 (1.24%) | **26** (1.15%) |
| ├── **HTTP 429 Rate-Limited** (Tenant Quota) | 0 (0.00%) | 890 (59.73%) | 0 (0.00%) | **890** (39.50%) |
| ├── **HTTP 503 Overloaded** (Backpressure Shed) | 0 (0.00%) | 352 (23.62%) | 615 (84.59%) | **967** (42.92%) |
| ├── **Other HTTP Responses** (4xx / 5xx) | 0 (0.00%) | 0 (0.00%) | 0 (0.00%) | **0** (0.00%) |
| └── **Network / Transport Timeouts** | 0 (0.00%) | 14 (0.94%) | 0 (0.00%) | **14** (0.62%) |
| **Reconciled Check Sum** | **36** ($36+0$) | **1,490** ($217+17+890+352+14$) | **727** ($103+9+615$) | **2,253** ($356+26+890+967+14$) |
| **Total Successful Acceptances** | **36** | **217** | **103** | **356** |
| **Server Crashes / HTTP 500 Responses** | **0** | **0** | **0** | **0** |

### Root Cause of the 14 Scenario B Errors
- In Scenario B, k6 recorded 14 transport errors (`relay_unexpected_errors_total = 14`, `http_req_failed = 14 / 1,490` = 0.94%).
- **Verification:** k6 logged these as:
  `time="2026-10-30T10:00:51+01:00" level=warning msg="Request Failed" error="Post \"http://127.0.0.1:3000/v1/notifications\": request timeout"`
- **Cause:** These were **client-side TCP socket timeouts** (k6 `timeout: '15s'`) occurring during maximum connection pool contention (35 concurrent VUs competing for the 15-connection Neon pool). Requests queued in the Node.js connection pool checkout queue beyond k6's 15-second client timeout threshold.
- **Server Health:** Zero HTTP 500 Internal Server Errors were returned. The Express server did not crash, terminate, or throw unhandled exceptions.

---

## 2. Corrected Infrastructure Cost Model

All cost projections are sourced directly from [`benchmarks/COST-MODEL.md`](file:///c:/Users/HP/Desktop/relay-system/benchmarks/COST-MODEL.md) based on official provider pricing verified on **30 October 2026** (AWS SES, Twilio, Neon, Render, Grafana Labs, AWS S3).

### Reconciled Cost Scenarios (100,000 Registered Users)

| Metric | Scenario A (Low Usage) | Scenario B (Expected Usage) | Scenario C (High Usage) |
| :--- | :---: | :---: | :---: |
| **Registered User Population** | 100,000 users | 100,000 users | 100,000 users |
| **Monthly Active Ratio** | 30% (30,000 MAU) | 60% (60,000 MAU) | 85% (85,000 MAU) |
| **Notifications / User / Month** | 2 msgs/user | 5 msgs/user | 20 msgs/user |
| **Monthly Notification Volume** | **60,000 / month** | **300,000 / month** | **1,700,000 / month** |
| **Channel Partition** | 85% Email / 15% SMS | 80% Email / 20% SMS | 75% Email / 25% SMS |
| **Server Infrastructure Cost** | **$43.38** (26.51%) | **$136.19** (14.92%) | **$369.46** (6.35%) |
| **Third-Party Telecommunications** | **$120.25** (73.49%) | **$776.65** (85.08%) | **$5,452.30** (93.65%) |
| **Total Monthly Operating Cost** | **$163.63** | **$912.84** | **$5,821.76** |
| **Cost per 1,000 Notifications** | **$2.73** | **$3.04** | **$3.42** |

### Itemized Breakdown (Scenario B — Expected Usage)
- **Server Infrastructure ($136.19):**
  - Render API Service (Standard 1 vCPU, 2 GB RAM): **$25.00**
  - Render Worker Daemon (Standard 1 vCPU, 2 GB RAM): **$25.00**
  - Neon Serverless PostgreSQL Compute (365 CU-hrs @ $0.106/CU-hr): **$38.69**
  - Neon PostgreSQL Storage (2.0 GB @ $0.35/GB-mo): **$0.70**
  - Render Redis Standard (1 GB RAM, persistence): **$20.00**
  - Grafana Cloud Pro Platform Fee: **$19.00**
  - Grafana Cloud Ingested Logs (15 GB @ $0.45/GB): **$6.75**
  - AWS S3 Database Snapshots (15 GB @ $0.023/GB): **$0.35**
  - Render Network Egress (7 GB billable @ $0.10/GB): **$0.70**
  - *Subtotal Server Infrastructure:* **$136.19**
- **Third-Party Telecommunications ($776.65):**
  - AWS SES Email Delivery (240,000 emails @ $0.10 / 1,000): **$24.00**
  - Twilio US Outbound SMS (60,000 segments @ $0.0125 blended base + carrier): **$750.00**
  - Twilio 10DLC Dedicated Local Phone Number: **$1.15**
  - TCR A2P 10DLC Campaign Registration: **$1.50**
  - *Subtotal Telecommunications:* **$776.65**
- **Total Monthly Cost:** $\$136.19 + \$776.65 = \mathbf{\$912.84}$.

---

## 3. Corrected Performance & Capacity Analysis

### Database Connection Pool Configuration
Inspection of the actual source code reveals the database connection pool settings:
- [`src/config/env.ts`](file:///c:/Users/HP/Desktop/relay-system/src/config/env.ts#L12): `DB_POOL_MAX` is configured with a default of **15 connections** (min: 1, max: 100).
- [`src/config/env.ts`](file:///c:/Users/HP/Desktop/relay-system/src/config/env.ts#L42): `BACKPRESSURE_DB_POOL_MAX_RATIO` is set to **0.90** (triggers admission shedding at 90% pool utilization = $\ge 13.5$ active clients).
- [`src/database/pool.ts`](file:///c:/Users/HP/Desktop/relay-system/src/database/pool.ts#L4-L9):
  ```typescript
  export const pool = new pg.Pool({
      connectionString: env.DATABASE_URL,
      max: env.DB_POOL_MAX, // 15
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 10000, // 10s connection checkout timeout
  });
  ```

### Separation of Throughput Metrics

To prevent contradictory or misleading claims, Relay distinguishes four distinct throughput concepts:

1. **Measured Total Ingress Evaluation Throughput (k6 Empirical):**
   - **28.33 req/s** peak incoming HTTP arrival rate evaluated during Scenario B.
   - Dominated by fast non-database defensive rejections (median 3.91 ms for 429s, < 10 ms for 503s).
2. **Measured Durable Acceptance Throughput (k6 Empirical):**
   - **4.13 accepted notifications/s** committed to PostgreSQL in Scenario B; **1.70 accepted/s** in Scenario A.
   - Each accepted request executes an atomic multi-table transaction writing `notifications`, `outbox_events`, and `idempotency_keys` across public cloud internet to London Neon PostgreSQL.
3. **Theoretical Single-Instance Prototype Capacity:**
   - **~10.7 – 15.0 accepted req/s** based on Little's Law with 15 max database connections and ~700–1,000ms cloud network round-trip latency per transaction ($15 \text{ conn} \div 1.0\text{s} \times 0.70 \text{ safe target}$).
4. **Enterprise Architectural Design Target:**
   - **579 avg req/s continuous / 5,787 peak req/s** (50M notifications/day enterprise specification).
   - This enterprise benchmark requires co-located multi-cluster database sharding, Kafka/Pulsar streaming tiers, and connection poolers, which are architectural designs in [`DESIGN.md`](file:///c:/Users/HP/Desktop/relay-system/DESIGN.md) rather than prototype single-node measurements.

---

## 4. Verified Design Patterns in Source Code

The graduation task requires at least three design patterns implemented in code and explicitly documented in comments. Source code inspection confirms **five** qualifying patterns:

1. **Transactional Outbox Pattern**
   - **Source:** [`src/services/notificationService.ts`](file:///c:/Users/HP/Desktop/relay-system/src/services/notificationService.ts#L12) & [`src/services/outboxDispatcher.ts`](file:///c:/Users/HP/Desktop/relay-system/src/services/outboxDispatcher.ts#L15)
   - **Comment:** `* Pattern: Transactional Outbox Pattern (Dispatch & Publication Phase)`
   - **Implementation:** Atomically commits notification and outbox event in PostgreSQL transaction, then polls `outbox_events` with `SELECT ... FOR UPDATE SKIP LOCKED` and publishes to BullMQ.
2. **Adapter Pattern**
   - **Source:** [`src/adapters/simulatedProvider.ts`](file:///c:/Users/HP/Desktop/relay-system/src/adapters/simulatedProvider.ts#L79-L84)
   - **Comment:** `* Pattern: Adapter Pattern`
   - **Implementation:** Encapsulates external email and SMS gateways behind a uniform interface with configurable simulated failure injection.
3. **Repository Pattern**
   - **Source:** [`src/repositories/notificationRepository.ts`](file:///c:/Users/HP/Desktop/relay-system/src/repositories/notificationRepository.ts#L5) & [`src/repositories/preferenceRepository.ts`](file:///c:/Users/HP/Desktop/relay-system/src/repositories/preferenceRepository.ts#L15)
   - **Comment:** `* Pattern: Repository Pattern`
   - **Implementation:** Isolates raw SQL queries and database connection management from business services.
4. **State Machine Pattern**
   - **Source:** [`src/services/backpressureService.ts`](file:///c:/Users/HP/Desktop/relay-system/src/services/backpressureService.ts#L34-L38)
   - **Comment:** `* Pattern: State Machine Pattern`
   - **Implementation:** Formally models cluster operational readiness into discrete states (`NORMAL`, `DEGRADED`, `OVERLOADED`) with strict transition thresholds and circuit damping.
5. **Exponential Backoff Pattern**
   - **Source:** [`src/queues/notificationQueues.ts`](file:///c:/Users/HP/Desktop/relay-system/src/queues/notificationQueues.ts#L6-L10)
   - **Comment:** `* Pattern: Exponential Backoff Pattern`
   - **Implementation:** BullMQ queue configuration with exponential backoff strategy for retrying transient delivery failures.

---

## 5. API Endpoints & Security Claims Audit

### Implemented Endpoints vs. Design Specifications

| Endpoint | Method | Implemented in Code? | Status Code Responses |
| :--- | :---: | :---: | :--- |
| `/v1/notifications` | `POST` | **YES** ([`src/routes/notifications.ts`](file:///c:/Users/HP/Desktop/relay-system/src/routes/notifications.ts)) | `202 Accepted`, `200 OK` (suppressed), `400 Bad Request`, `409 Conflict`, `429 Too Many Requests`, `503 Service Unavailable`, `500 Internal Error` |
| `/v1/recipients/preferences` | `PUT` | **YES** ([`src/routes/preferences.ts`](file:///c:/Users/HP/Desktop/relay-system/src/routes/preferences.ts)) | `200 OK`, `400 Bad Request`, `500 Internal Error` |
| `/v1/recipients/preferences` | `GET` | **YES** ([`src/routes/preferences.ts`](file:///c:/Users/HP/Desktop/relay-system/src/routes/preferences.ts)) | `200 OK`, `400 Bad Request`, `404 Not Found`, `500 Internal Error` |
| `/v1/health` | `GET` | **YES** ([`src/app.ts`](file:///c:/Users/HP/Desktop/relay-system/src/app.ts)) | `200 OK` |
| `/v1/ready` | `GET` | **YES** ([`src/routes/ready.ts`](file:///c:/Users/HP/Desktop/relay-system/src/routes/ready.ts)) | `200 OK`, `503 Service Unavailable` |
| `/metrics` | `GET` | **YES** ([`src/app.ts`](file:///c:/Users/HP/Desktop/relay-system/src/app.ts)) | `200 OK` (Prometheus exposition) |
| `/v1/notifications/:id` | `GET` | **NO** *(DESIGN.md only)* | Documented in [`DESIGN.md` §3](file:///c:/Users/HP/Desktop/relay-system/DESIGN.md#L140-L150) as target API specification; not implemented in Express router. |

### Implemented HTTP Status Codes
- **Implemented in Code:** `200`, `202`, `400`, `404`, `409`, `429`, `500`, `503`.
- **Specified in DESIGN.md for Production Only:** `401 Unauthorized`, `403 Forbidden`, `412 Precondition Failed`, `428 Precondition Required`.

### Tenant Authentication & Security Claims (Prototype vs. Production)
- **Prototype Limitation:**
  In the prototype, tenant identification is accepted via `req.body.customerId` in the JSON payload. There is **no authentication middleware** (e.g. JWT verification, API key lookups) and **no authorization/RBAC** enforcing tenant boundaries.
- **Production Defense Requirement:**
  In a production deployment, an API Gateway or Bearer token authentication middleware must validate cryptographic tokens (e.g. OAuth2/JWT) and inject a verified `customerId` into the request context. This distinction is documented as an intentional prototype boundary.

---

## 6. Deliverable 1 Audit — `DESIGN.md` (12 Sections)

All 12 sections required by Part 3 of the Graduation Task were verified:
1. **Requirements & Scope:** PASS ([`DESIGN.md` §1](file:///c:/Users/HP/Desktop/relay-system/DESIGN.md#L14))
2. **Back-of-Envelope Estimates:** PASS ([`DESIGN.md` §2](file:///c:/Users/HP/Desktop/relay-system/DESIGN.md#L64))
3. **API Design & Contracts:** PASS ([`DESIGN.md` §3](file:///c:/Users/HP/Desktop/relay-system/DESIGN.md#L124))
4. **Data Model & Schema:** PASS ([`DESIGN.md` §4](file:///c:/Users/HP/Desktop/relay-system/DESIGN.md#L312))
5. **High-Level Architecture Diagram:** PASS ([`DESIGN.md` §5](file:///c:/Users/HP/Desktop/relay-system/DESIGN.md#L462))
6. **Three Technical Deep Dives:** PASS ([`DESIGN.md` §6, §7, §8, §16](file:///c:/Users/HP/Desktop/relay-system/DESIGN.md#L522))
7. **Design Patterns ($\ge 5$):** PASS ([`DESIGN.md` §9](file:///c:/Users/HP/Desktop/relay-system/DESIGN.md#L782))
8. **Scaling Plan (1k, 100k, 10M):** PASS ([`DESIGN.md` §10](file:///c:/Users/HP/Desktop/relay-system/DESIGN.md#L862))
9. **Caching, Replication & Sharding:** PASS ([`DESIGN.md` §10.2–§10.4](file:///c:/Users/HP/Desktop/relay-system/DESIGN.md#L900))
10. **Failure Modes ($\ge 10$):** PASS ([`DESIGN.md` §11](file:///c:/Users/HP/Desktop/relay-system/DESIGN.md#L962))
11. **Architectural Trade-offs ($\ge 5$):** PASS ([`DESIGN.md` §12](file:///c:/Users/HP/Desktop/relay-system/DESIGN.md#L1082))
12. **Infrastructure Cost Estimates:** PASS ([`DESIGN.md` §12.3](file:///c:/Users/HP/Desktop/relay-system/DESIGN.md#L1152))

---

## 7. Deliverable 2 Audit — Working Prototype (12 Criteria)

All 12 criteria for the working prototype were verified in code and tests:
1. **Accepts Requests:** PASS ([`src/routes/notifications.ts`](file:///c:/Users/HP/Desktop/relay-system/src/routes/notifications.ts))
2. **Recipient Preferences:** PASS ([`src/services/preferenceService.ts`](file:///c:/Users/HP/Desktop/relay-system/src/services/preferenceService.ts))
3. **Queues Accepted Messages:** PASS ([`src/services/outboxDispatcher.ts`](file:///c:/Users/HP/Desktop/relay-system/src/services/outboxDispatcher.ts))
4. **Supports Email & SMS:** PASS ([`src/workers/emailWorker.ts`](file:///c:/Users/HP/Desktop/relay-system/src/workers/emailWorker.ts), [`src/workers/smsWorker.ts`](file:///c:/Users/HP/Desktop/relay-system/src/workers/smsWorker.ts))
5. **Simulates Provider Failures:** PASS ([`src/adapters/simulatedProvider.ts`](file:///c:/Users/HP/Desktop/relay-system/src/adapters/simulatedProvider.ts))
6. **Retries Transient Failures:** PASS (BullMQ exponential backoff + lease release in workers)
7. **Handles Permanent Failures & Timeouts:** PASS (400 -> `failed`, 504 -> `outcome_unknown`)
8. **Prevents Ingress Duplicates:** PASS (SHA-256 fingerprint on `idempotency_keys`)
9. **Documents Limits of Exactly-Once:** PASS ([`DESIGN.md` §6](file:///c:/Users/HP/Desktop/relay-system/DESIGN.md#L522), [`SUBMISSION.md` §20](file:///c:/Users/HP/Desktop/relay-system/SUBMISSION.md))
10. **Implements $\ge 3$ Design Patterns in Code:** PASS (5 patterns verified with comments)
11. **k6 Load Testing & Saved Evidence:** PASS ([`benchmarks/k6/`](file:///c:/Users/HP/Desktop/relay-system/benchmarks/k6/))
12. **Failure Drill Evidence:** PASS ([`scripts/providerFailureDrill.ts`](file:///c:/Users/HP/Desktop/relay-system/scripts/providerFailureDrill.ts), [`DESIGN.md` §11.1](file:///c:/Users/HP/Desktop/relay-system/DESIGN.md#L1040))

---

## 8. Build & Automated Regression Suite

Verification commands executed:
- `npm.cmd run build`: Exited with code **0** (TypeScript compiled with 0 errors).
- `npm.cmd test`: Exited with code **0** (95 tests passed across 11 test files).

```
Test Files  11 passed (11)
     Tests  95 passed (95)
```

---

## 9. Remaining Graduation Submission Requirements

To achieve 100% completion of the Dev and Design HQ Graduation Task:

1. **Deliverable 3: 20-minute Walkthrough Video (PENDING)**
   - Record candidate presentation walking through `DESIGN.md`, key architectural decisions, codebase walkthrough, live multi-terminal demo per [`DEMO-GUIDE.md`](file:///c:/Users/HP/Desktop/relay-system/DEMO-GUIDE.md), and failure drills.
2. **Deliverable 4: Mock Technical Interview (PENDING)**
   - Participate in oral graduation defense answering architectural challenge questions using [`INTERVIEW-PREP.md`](file:///c:/Users/HP/Desktop/relay-system/INTERVIEW-PREP.md).
3. **Repository Publishing (Awaiting User Approval):**
   - Code changes remain unstaged and uncommitted per instructions.
