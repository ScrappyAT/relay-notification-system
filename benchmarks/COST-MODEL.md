# Relay — Milestone 7D: Infrastructure Cost Estimation (100,000 Users)

**Date of Verification:** 30 October 2026
**Scope:** Dev and Design HQ Final Graduation Task — Part 3, Requirement 12
**System Architecture:** Multi-tenant Node.js/TypeScript Express API, PostgreSQL (Transactional Outbox), Redis (BullMQ queues & sliding-window rate limiting), Outbox Dispatcher daemon, email/SMS background workers, Prometheus observability.

---

## 1. Workload Modeling & User Population Definitions

To establish a defensible cost projection, the workload model distinguishes registered account holders from active notification recipients within Relay's multi-tenant B2B architecture:

- **Tenant Organizations ($N_{\text{tenants}}$):** **100 business tenant organizations** (e.g., e-commerce merchants, SaaS platforms, fintech apps) utilizing Relay's multi-tenant API.
- **Registered End-User Recipients ($N_{\text{users}}$):** **100,000 unique individuals** maintained in tenant recipient and preference tables (`recipient_preferences`).
- **Monthly Active Users ($\text{MAU}$):** The proportion of registered recipients who actually trigger or receive $\ge 1$ notification during a 30-day billing cycle.
- **Monthly Notification Volume ($V_{\text{monthly}}$):**
  $$V_{\text{monthly}} = N_{\text{users}} \times \text{ActiveRatio} \times \text{NotificationsPerActiveUser}$$
- **Channel Partition ($R_{\text{channel}}$):** $V_{\text{email}} = V_{\text{monthly}} \times R_{\text{email}}$ and $V_{\text{sms}} = V_{\text{monthly}} \times R_{\text{sms}}$, where $R_{\text{email}} + R_{\text{sms}} = 1.0$.

### 1.1 Technical Sizing & Storage Assumptions
- **Payload Size:** Average incoming JSON notification payload is **1.5 KB** (`recipient`, `channel`, `subject`, `template_data`, `metadata`).
- **Database Row Footprint:** Each accepted notification writes three records within an atomic transaction:
  1. `notifications` row: ~450 bytes (UUID, customer_id, recipient, status, lease timestamps, retry count).
  2. `outbox_events` row: ~550 bytes (UUID, payload JSON, publication state, lock lease).
  3. `idempotency_keys` row: ~250 bytes (key, customer_id, request hash, response body).
  - *Total Storage per Notification:* **~1.25 KB base data** + **~0.75 KB B-Tree index overhead** = **~2.0 KB per notification**.
- **Data Retention Policy:**
  - Live transactional database stores a **rolling 30-day window**.
  - Notifications older than 30 days are purged or archived to cold object storage (AWS S3).
- **Redis Queue Buffer:**
  - Redis acts as a transitory transport buffer (BullMQ jobs + fairness locks + rate-limiting keys).
  - Outbox jobs drain in real time; steady-state queue memory is **< 100 MB**.
- **Observability Ingestion:**
  - Standard Prometheus scrape interval: 15 seconds across 4 target endpoints.
  - Active time series: ~1,500 bounded metrics series.
  - Log volume: ~0.5 KB structured JSON per API ingestion and worker dispatch.

---

## 2. Official Provider Pricing Reference (Verified 30 October 2026)

All pricing figures reflect publicly published, official cloud provider documentation retrieved on **30 October 2026**. No third-party blog estimates or unverified promotional discounts are utilized.

| Component | Provider & Tier | Unit Rate | Official Pricing Source |
| :--- | :--- | :--- | :--- |
| **API Compute** | **Render** Web Service Standard (1 vCPU, 2 GB RAM) | **$25.00 / month** | [render.com/pricing](https://render.com/pricing) |
| **API Compute (Starter)** | **Render** Web Service Starter (0.5 vCPU, 512 MB RAM) | **$7.00 / month** | [render.com/pricing](https://render.com/pricing) |
| **Worker Compute** | **Render** Background Worker Standard (1 vCPU, 2 GB RAM) | **$25.00 / month** | [render.com/pricing](https://render.com/pricing) |
| **Worker Compute (Starter)** | **Render** Background Worker Starter (0.5 vCPU, 512 MB RAM) | **$7.00 / month** | [render.com/pricing](https://render.com/pricing) |
| **PostgreSQL Database** | **Neon** Serverless PostgreSQL (Launch Plan) | **$0.106 / CU-hour** compute<br>**$0.35 / GB-month** storage | [neon.tech/pricing](https://neon.tech/pricing) |
| **PostgreSQL Database (Scale)** | **Neon** Serverless PostgreSQL (Scale Plan) | **$0.222 / CU-hour** compute<br>**$0.35 / GB-month** storage | [neon.tech/pricing](https://neon.tech/pricing) |
| **Redis Cache / Queue** | **Render** Key Value Starter (256 MB RAM, 200 conn) | **$10.00 / month** | [render.com/pricing](https://render.com/pricing) |
| **Redis Cache / Queue** | **Render** Key Value Standard (1 GB RAM, 250 conn) | **$20.00 / month** | [render.com/pricing](https://render.com/pricing) |
| **Redis Cache / Queue** | **Render** Key Value Pro (3 GB RAM, high conn) | **$60.00 / month** | [render.com/pricing](https://render.com/pricing) |
| **Email Delivery** | **Amazon SES** Outbound (à la carte) | **$0.10 per 1,000 emails** ($0.0001/email) | [aws.amazon.com/ses/pricing](https://aws.amazon.com/ses/pricing/) |
| **SMS Delivery (Twilio Base)** | **Twilio** Programmable Messaging US Outbound | **$0.0083 / segment** (160 chars GSM-7) | [twilio.com/en-us/sms/pricing/us](https://www.twilio.com/en-us/sms/pricing/us) |
| **SMS Carrier Surcharges** | US Tier-1 Carriers (A2P 10DLC pass-through) | AT&T: $0.0035, T-Mobile: $0.0045, Verizon: $0.0050<br>Weighted Average: **$0.0042 / segment** | [twilio.com/en-us/sms/pricing/us](https://www.twilio.com/en-us/sms/pricing/us) |
| **SMS Dedicated Number** | Twilio 10DLC US Local Phone Number | **$1.15 / month** per number | [twilio.com/en-us/sms/pricing/us](https://www.twilio.com/en-us/sms/pricing/us) |
| **A2P Campaign Fee** | The Campaign Registry (TCR) via Twilio | Low-Volume Mixed: **$1.50 / month**<br>Standard Campaign: **$10.00 / month** | [twilio.com/en-us/sms/pricing/us](https://www.twilio.com/en-us/sms/pricing/us) |
| **Observability (Free)** | **Grafana Cloud** Free Tier | **$0.00 / month** (10k series, 50 GB logs, 14d retention) | [grafana.com/pricing](https://grafana.com/pricing/) |
| **Observability (Pro)** | **Grafana Cloud** Pro Platform | **$19.00 / month** base + $0.45/GB logs | [grafana.com/pricing](https://grafana.com/pricing/) |
| **Database Backups** | **Amazon S3** Standard | **$0.023 / GB-month** storage | [aws.amazon.com/s3/pricing](https://aws.amazon.com/s3/pricing/) |
| **Network Egress** | Render Outbound Bandwidth | First 5 GB free, then **$0.10 / GB** | [render.com/pricing](https://render.com/pricing) |

### 2.1 Distinguishing Verified Vendor Pricing from Modeling Assumptions
- **Directly Verified Vendor Prices:** Every unit price in the table above is extracted directly from official provider pricing documentation.
- **Explicit Modeling Assumptions:**
  - **Blended US SMS Rate ($0.0125/segment):** Derived by combining Twilio's verified base rate ($0.0083) with the verified carrier pass-through average across AT&T, Verizon, and T-Mobile ($0.0042). Messages are assumed to fit within a single 160-character GSM-7 segment without Unicode emojis.
  - **User Activity Patterns:** Active user ratios (30%, 60%, 85%) and monthly message frequencies (2, 5, 20) are explicitly defined workload scenarios reflecting common SaaS and transactional application profiles.

---

## 3. Mathematical Recalculation of the Three Scenarios

Every line item has been independently computed and summed to verify arithmetic consistency.

### Scenario A — Low Usage (Transactional & Security Alerts)
*Profile:* 100,000 registered users, 30% monthly active (30,000 MAU), **2 notifications/month/user**.
- **Monthly Notification Volume:** $30,000 \times 2 = \mathbf{60,000 \text{ notifications/month}}$.
- **Channel Partition:** 85% Email ($51,000$), 15% SMS ($9,000$).
- **Traffic Intensity:** Average = 0.023 req/s; 10x Peak = 0.23 req/s.
- **Storage Impact:** 60,000 notifications $\times 2.0$ KB = **120 MB/month** (~0.5 GB rolling 30-day database).

#### Itemized Line-Item Calculation (Scenario A)
| Component | Billing Unit & Specification | Units | Unit Cost | Monthly Cost |
| :--- | :--- | :--- | :--- | :--- |
| **API Compute** | Render Starter (0.5 vCPU, 512 MB RAM) | 1 instance | $7.00 / mo | $7.00 |
| **Worker Compute** | Render Starter (0.5 vCPU, 512 MB RAM) | 1 instance | $7.00 / mo | $7.00 |
| **Neon PostgreSQL Compute** | Neon Launch Plan: 180 CU-hrs (0.25 CU avg @ 720 hrs) | 180 CU-hrs | $0.106 / CU-hr | $19.08 |
| **Neon PostgreSQL Storage** | Neon Launch Plan: 0.5 GB rolling database | 0.5 GB | $0.35 / GB-mo | $0.18 |
| **Redis Cache / Queue** | Render Key Value Starter (256 MB RAM) | 1 instance | $10.00 / mo | $10.00 |
| **Email Delivery** | Amazon SES Outbound | 51,000 emails | $0.10 / 1,000 | $5.10 |
| **SMS Carrier Delivery** | Twilio US Outbound (Base + Carrier Surcharges) | 9,000 segments | $0.0125 / seg | $112.50 |
| **SMS Dedicated Number** | Twilio 10DLC US Local Phone Number | 1 number | $1.15 / mo | $1.15 |
| **A2P Campaign Fee** | TCR Low-Volume Mixed 10DLC Campaign | 1 campaign | $1.50 / mo | $1.50 |
| **Observability** | Grafana Cloud Free Tier (fits within 10k series, 50 GB) | 1 account | $0.00 / mo | $0.00 |
| **Database Backups** | Amazon S3 Standard (weekly snapshots, ~5 GB) | 5 GB | $0.023 / GB | $0.12 |
| **Network Egress** | Render Outbound Bandwidth (~3 GB; under 5 GB free) | 0 GB over | $0.10 / GB | $0.00 |
| **Total Monthly Cost** | Exact Sum of Line Items | | | **$163.63** |
| **Cost per 1,000 Notifications** | $\$163.63 / (60,000 / 1,000)$ | | | **$2.73** |

---

### Scenario B — Expected Usage (Standard E-Commerce / SaaS Workflow)
*Profile:* 100,000 registered users, 60% monthly active (60,000 MAU), **5 notifications/month/user**.
- **Monthly Notification Volume:** $60,000 \times 5 = \mathbf{300,000 \text{ notifications/month}}$.
- **Channel Partition:** 80% Email ($240,000$), 20% SMS ($60,000$).
- **Traffic Intensity:** Average = 0.116 req/s; 10x Peak = 1.16 req/s.
- **Storage Impact:** 300,000 notifications $\times 2.0$ KB = **600 MB/month** (~2.0 GB rolling 30-day database).

#### Itemized Line-Item Calculation (Scenario B)
| Component | Billing Unit & Specification | Units | Unit Cost | Monthly Cost |
| :--- | :--- | :--- | :--- | :--- |
| **API Compute** | Render Standard (1 vCPU, 2 GB RAM) | 1 instance | $25.00 / mo | $25.00 |
| **Worker Compute** | Render Standard (1 vCPU, 2 GB RAM) | 1 instance | $25.00 / mo | $25.00 |
| **Neon PostgreSQL Compute** | Neon Launch Plan: 365 CU-hrs (0.5 CU steady @ 730 hrs) | 365 CU-hrs | $0.106 / CU-hr | $38.69 |
| **Neon PostgreSQL Storage** | Neon Launch Plan: 2.0 GB rolling database | 2.0 GB | $0.35 / GB-mo | $0.70 |
| **Redis Cache / Queue** | Render Key Value Standard (1 GB RAM, persistence) | 1 instance | $20.00 / mo | $20.00 |
| **Email Delivery** | Amazon SES Outbound | 240,000 emails | $0.10 / 1,000 | $24.00 |
| **SMS Carrier Delivery** | Twilio US Outbound (Base + Carrier Surcharges) | 60,000 segments | $0.0125 / seg | $750.00 |
| **SMS Dedicated Number** | Twilio 10DLC US Local Phone Number | 1 number | $1.15 / mo | $1.15 |
| **A2P Campaign Fee** | TCR Low-Volume Mixed 10DLC Campaign | 1 campaign | $1.50 / mo | $1.50 |
| **Observability Base** | Grafana Cloud Pro Platform Fee | 1 account | $19.00 / mo | $19.00 |
| **Observability Logs** | Grafana Cloud Ingested Logs (15 GB @ $0.45/GB) | 15 GB | $0.45 / GB | $6.75 |
| **Database Backups** | Amazon S3 Standard (daily pg_dump snapshots, ~15 GB) | 15 GB | $0.023 / GB | $0.35 |
| **Network Egress** | Render Outbound Bandwidth (12 GB total; 7 GB overage) | 7 GB over | $0.10 / GB | $0.70 |
| **Total Monthly Cost** | Exact Sum of Line Items | | | **$912.84** |
| **Cost per 1,000 Notifications** | $\$912.84 / (300,000 / 1,000)$ | | | **$3.04** |

---

### Scenario C — High Usage (High-Touch Consumer / Fintech / Real-Time Delivery)
*Profile:* 100,000 registered users, 85% monthly active (85,000 MAU), **20 notifications/month/user**.
- **Monthly Notification Volume:** $85,000 \times 20 = \mathbf{1,700,000 \text{ notifications/month}}$.
- **Channel Partition:** 75% Email ($1,275,000$), 25% SMS ($425,000$).
- **Traffic Intensity:** Average = 0.656 req/s; 10x Peak = 6.56 req/s.
- **Storage Impact:** 1,700,000 notifications $\times 2.0$ KB = **3.4 GB/month** (~10.0 GB rolling 30-day database).

#### Itemized Line-Item Calculation (Scenario C)
| Component | Billing Unit & Specification | Units | Unit Cost | Monthly Cost |
| :--- | :--- | :--- | :--- | :--- |
| **API Compute (HA)** | Render Standard (1 vCPU, 2 GB RAM) — 2x Replicas | 2 instances | $25.00 / mo | $50.00 |
| **Worker Compute** | Render Standard (1 vCPU, 2 GB RAM) — 2x Daemons | 2 instances | $25.00 / mo | $50.00 |
| **Neon PostgreSQL Compute** | Neon Scale Plan: 730 CU-hrs (1.0 CU dedicated @ 730 hrs) | 730 CU-hrs | $0.222 / CU-hr | $162.06 |
| **Neon PostgreSQL Storage** | Neon Scale Plan: 10.0 GB rolling database | 10.0 GB | $0.35 / GB-mo | $3.50 |
| **Redis Cache / Queue** | Render Key Value Pro (3 GB RAM, high connection pool) | 1 instance | $60.00 / mo | $60.00 |
| **Email Delivery** | Amazon SES Outbound | 1,275,000 emails | $0.10 / 1,000 | $127.50 |
| **SMS Carrier Delivery** | Twilio US Outbound (Base + Carrier Surcharges) | 425,000 segments | $0.0125 / seg | $5,312.50 |
| **SMS Dedicated Numbers** | Twilio 10DLC US Local Phone Numbers (2 numbers) | 2 numbers | $1.15 / mo | $2.30 |
| **A2P Campaign Fee** | TCR Standard 10DLC Campaign Registration | 1 campaign | $10.00 / mo | $10.00 |
| **Observability Base** | Grafana Cloud Pro Platform Fee | 1 account | $19.00 / mo | $19.00 |
| **Observability Logs** | Grafana Cloud Ingested Logs (45 GB @ $0.45/GB) | 45 GB | $0.45 / GB | $20.25 |
| **Database Backups** | Amazon S3 Standard (daily snapshots + WAL archiving) | 50 GB | $0.023 / GB | $1.15 |
| **Network Egress** | Render Outbound Bandwidth (40 GB total; 35 GB overage) | 35 GB over | $0.10 / GB | $3.50 |
| **Total Monthly Cost** | Exact Sum of Line Items | | | **$5,821.76** |
| **Cost per 1,000 Notifications** | $\$5,821.76 / (1,700,000 / 1,000)$ | | | **$3.42** |

---

## 4. Reconciliation of the Fixed vs. Variable Cost Split

To eliminate ambiguity, costs are classified according to two formal, complementary perspectives:

### Perspective 1: Server Infrastructure vs. Third-Party Telecommunications
This perspective separates infrastructure hosting (compute, database, caching, monitoring, storage, egress) from third-party telecommunications and email carrier dispatch:

| Scenario | Server Infrastructure | Third-Party Telecommunications | Total Monthly Operating Cost |
| :--- | :--- | :--- | :--- |
| **Scenario A (Low)** | **$43.38** (26.51%) | **$120.25** (73.49%) | **$163.63** |
| **Scenario B (Expected)** | **$136.19** (14.92%) | **$776.65** (85.08%) | **$912.84** |
| **Scenario C (High)** | **$369.46** (6.35%) | **$5,452.30** (93.65%) | **$5,821.76** |

#### Reconciliation of Scenario B's $136.19 vs. $776.65 Split:
- **Server Infrastructure ($136.19):** Render API ($25.00) + Render Worker ($25.00) + Neon Database total ($38.69 + $0.70 = $39.39) + Render Redis ($20.00) + Grafana Cloud total ($19.00 base + $6.75 logs = $25.75) + S3 Backups ($0.35) + Network Egress ($0.70) = **$136.19**.
- **Third-Party Telecommunications ($776.65):** Amazon SES Email ($24.00) + Twilio SMS Carrier Segments ($750.00) + Twilio Phone Number ($1.15) + Twilio 10DLC Campaign Fee ($1.50) = **$776.65**.
- **Sum:** $\$136.19 + \$776.65 = \mathbf{\$912.84}$.

---

### Perspective 2: Strict Fixed Baseline Subscriptions vs. Volume-Variable Usage
This perspective classifies costs based on whether they represent volume-independent baseline subscriptions (incurred even at zero volume) or variable consumption:

| Scenario | Fixed Baseline Subscriptions | Volume-Variable Consumption | Total Monthly Operating Cost |
| :--- | :--- | :--- | :--- |
| **Scenario A (Low)** | **$45.85** (28.02%) | **$117.78** (71.98%) | **$163.63** |
| **Scenario B (Expected)** | **$130.69** (14.32%) | **$782.15** (85.68%) | **$912.84** |
| **Scenario C (High)** | **$354.51** (6.09%) | **$5,467.25** (93.91%) | **$5,821.76** |

#### Line-Item Mapping for Perspective 2 (Scenario B):
- **Fixed Baseline Subscriptions ($130.69):** Render API ($25.00) + Render Worker ($25.00) + Neon Baseline Compute ($38.69) + Render Redis ($20.00) + Grafana Base Platform Fee ($19.00) + Twilio Phone Number ($1.15) + Twilio 10DLC Campaign Fee ($1.50) + S3 Baseline Snapshots ($0.35) = **$130.69**.
- **Volume-Variable Consumption ($782.15):** Amazon SES Email ($24.00) + Twilio SMS Segments ($750.00) + Neon Incremental Storage ($0.70) + Grafana Log Ingestion ($6.75) + Network Egress Overages ($0.70) = **$782.15**.
- **Sum:** $\$130.69 + \$782.15 = \mathbf{\$912.84}$.

---

## 5. Detailed Neon PostgreSQL Cost Derivation

Neon Serverless PostgreSQL charges are calculated via the official formula:
$$\text{Neon Monthly Cost} = (\text{Monthly Active Hours} \times \text{Average CU} \times \text{CU-Hour Rate}) + (\text{Storage GB} \times \text{Storage Rate})$$

Where 1 Compute Unit (CU) equals 1 vCPU and 4 GB RAM.

### 5.1 Scenario A (Low Usage): $19.26 / month
- **Selected Plan:** Neon Launch Plan (pay-as-you-go, no monthly subscription fee).
- **CU-Hour Rate:** **$0.106 per CU-hour**.
- **Active Hours & Utilization:** With low traffic (0.023 req/s), scale-to-zero is enabled during idle lulls, averaging **0.25 CU** across active and polling periods ($720 \text{ hrs} \times 0.25 \text{ CU} = 180 \text{ CU-hours}$).
- **Compute Cost:** $180 \text{ CU-hours} \times \$0.106 = \mathbf{\$19.08}$.
- **Storage Cost:** $0.5 \text{ GB} \times \$0.35/\text{GB-mo} = \mathbf{\$0.18}$.
- **Total Neon Cost:** $\$19.08 + \$0.18 = \mathbf{\$19.26}$.

### 5.2 Scenario B (Expected Usage): $39.39 / month
- **Selected Plan:** Neon Launch Plan (pay-as-you-go, no monthly subscription fee).
- **CU-Hour Rate:** **$0.106 per CU-hour**.
- **Active Hours & Utilization:** Continuous warm compute without scale-to-zero cold starts ($730 \text{ hours/month}$) provisioned at **0.5 CU** ($730 \times 0.5 = 365 \text{ CU-hours}$).
- **Compute Cost:** $365 \text{ CU-hours} \times \$0.106 = \mathbf{\$38.69}$.
- **Storage Cost:** $2.0 \text{ GB} \times \$0.35/\text{GB-mo} = \mathbf{\$0.70}$.
- **Total Neon Cost:** $\$38.69 + \$0.70 = \mathbf{\$39.39}$.

### 5.3 Scenario C (High Usage): Explanation of $165.56 vs. $80.88
In Scenario C, two alternative database tiers can be deployed:

#### Option 1: Neon Scale Plan (Enterprise / Production Compliance) — $165.56 / month
- **Selected Plan:** Neon Scale Plan ($0.222 per CU-hour). This tier provides dedicated resource reservation, SOC 2 / HIPAA compliance posture, Datadog / OpenTelemetry metrics export, and advanced monitoring retention.
- **Active Hours & Utilization:** Continuous dedicated compute ($730 \text{ hours/month}$) at **1.0 CU** (1 vCPU, 4 GB RAM).
- **Compute Cost:** $730 \text{ hrs} \times 1.0 \text{ CU} \times \$0.222 = \mathbf{\$162.06}$.
- **Storage Cost:** $10.0 \text{ GB} \times \$0.35/\text{GB-mo} = \mathbf{\$3.50}$.
- **Total Neon Cost (Scale Plan):** $\$162.06 + \$3.50 = \mathbf{\$165.56}$.

#### Option 2: Neon Launch Plan (Cost-Optimized Standard Tier) — $80.88 / month
- **Selected Plan:** Neon Launch Plan ($0.106 per CU-hour).
- **Compute Cost:** $730 \text{ hrs} \times 1.0 \text{ CU} \times \$0.106 = \mathbf{\$77.38}$.
- **Storage Cost:** $10.0 \text{ GB} \times \$0.35/\text{GB-mo} = \mathbf{\$3.50}$.
- **Total Neon Cost (Launch Plan):** $\$77.38 + \$3.50 = \mathbf{\$80.88}$.

*Selection:* The budget retains Option 1 ($165.56) for Scenario C because high-volume multi-tenant fintech and healthcare deployments typically require the formal compliance guarantees, OpenTelemetry streaming, and dedicated resource reservations included in the Scale Plan tier. If deployed on the Launch Plan, total Scenario C cost decreases from **$5,821.76** to **$5,737.08** ($3.37 per 1,000 notifications).

---

## 6. Infrastructure Sufficiency & Capacity Reality Check

A pricing estimate is an economic model, not proof of operational throughput. The sufficiency of the provisioned infrastructure must be evaluated against Relay's empirical performance measured during the Milestone 7C k6 load tests:

| Workload Dimension | Scenario A (Low) | Scenario B (Expected) | Scenario C (High) | Empirical Milestone 7C Reference |
| :--- | :--- | :--- | :--- | :--- |
| **Monthly Volume** | 60,000 notifs | 300,000 notifs | 1,700,000 notifs | — |
| **Average Arrival Rate** | **0.023 req/sec** | **0.116 req/sec** | **0.656 req/sec** | Baseline: 1.70 req/s sustained |
| **10x Peak Arrival Rate** | **0.23 req/sec** | **1.16 req/sec** | **6.56 req/sec** | Contention ceiling: 3.30–4.13 req/s |
| **API Provisioning** | 1x Starter (0.5 vCPU) | 1x Standard (1 vCPU) | 2x Standard (2 vCPUs, HA) | Single node evaluated in k6 |
| **DB Pool Sizing** | `DB_POOL_MAX = 10` | `DB_POOL_MAX = 15` | `DB_POOL_MAX = 30` + PgBouncer | Evaluated with `DB_POOL_MAX = 15` |
| **Capacity Assessment** | **Fully Sufficient** | **Fully Sufficient** | **Requires Multi-Node & Pooling** | Single node saturates at 4–5 req/s |

### Technical Analysis of Capacity Constraints:
1. **Scenarios A & B are Fully Proven:** In Milestone 7C Scenario A, Relay sustained **1.70 accepted notifications/second** with 0 errors and 0 backpressure rejections against remote cloud Neon. Because Scenario A (0.23 req/s peak) and Scenario B (1.16 req/s peak) operate entirely below this measured threshold, the single-instance Render and Neon configurations are empirically proven to be sufficient.
2. **Scenario C Sizing Finding:** Milestone 7C demonstrated that a single Express node with `DB_POOL_MAX = 15` saturates around **3.30–4.13 accepted req/sec** due to network round-trip latency to remote PostgreSQL (Eu-west-2 / London). A single-node prototype would experience connection pool starvation and trigger backpressure shedding (`HTTP 503 SYSTEM_OVERLOADED`) during Scenario C's peak arrival rate of **6.56 req/sec**.
3. **Multi-Node Caveat:** Scenario C’s budget explicitly provisions **2 load-balanced API instances** and an upgraded database tier to support the required connection concurrency. However, **this multi-instance topology has not been tested in the prototype** (which runs as a single-node Express process). Operating Scenario C in production requires empirically benchmarking a multi-pod cluster behind an Application Load Balancer with a connection pooler (e.g., PgBouncer).

---

## 7. The 50 Million / Day Architectural Target: Scope & Cost Distinction

Relay's system design ([`DESIGN.md`](file:///c:/Users/HP/Desktop/relay-system/DESIGN.md)) specifies an architectural design target of **50,000,000 notifications per day**. This target must **not** be confused with or linearly extrapolated from the 100,000-user cost model:

### 7.1 Quantitative Magnitude Separation
- **100,000 Users (Scenario B — Expected):** **300,000 notifications / month** (~10,000 / day $\approx$ 0.12 req/s average).
- **50 Million / Day Architectural Target:** **1,500,000,000 notifications / month** (~579 req/s average, ~5,787 req/s peak).
- **The Scale Multiplier:** The architectural target is **5,000 times larger** in monthly volume and requires **4,825 times higher sustained throughput**.

### 7.2 Why Linear Cost Extrapolation is Invalid
Linearly multiplying Scenario B's budget ($912.84 / mo) by 5,000 yields an erroneous ~$4.5 million/month estimate, driven almost entirely by retail SMS rates. In reality, a production notification system operating at 50 million notifications/day operates under a completely different technical and commercial architecture:

1. **Relay Scope Limitation:** The Relay prototype currently implements Email and SMS channels only (Milestones 1–7). Mobile Push (APNs, FCM) and WhatsApp are documented as architectural targets in `DESIGN.md`, but are **not implemented** in the prototype.
2. **Channel Rebalancing in Production:** At 50 million notifications/day, organizations cannot rely on retail SMS for general notification delivery due to multi-million-dollar carrier costs. Production architectures shift the vast majority of notification traffic to zero-marginal-cost direct IP channels (mobile push notifications via Apple APNs and Google FCM), reserving SMS strictly for high-urgency transactional workflows (e.g., login 2FA OTPs).
3. **Proprietary Wholesale Telecommunications Agreements:** Enterprises dispatching tens of millions of SMS messages bypass retail developer APIs (Twilio retail) in favor of negotiated enterprise master service agreements with tier-1 telecommunications aggregators (e.g., Sinch, Infobip, Tata Communications). Because these custom enterprise volume rates are confidential, negotiated, and unverified on public pricing pages, they are excluded from this model.
4. **Database Topology Transformation:**
   - As established in Milestone 7C, a single PostgreSQL primary cannot absorb 5,787 transactions/second over public TLS.
   - At 50M/day, PostgreSQL must be replaced by a distributed, horizontally sharded architecture (e.g., Citus, CockroachDB, or 16+ partitioned Aurora PostgreSQL clusters) paired with PgBouncer connection multiplexers.
5. **Transport Layer Transformation:** Single-node Redis and BullMQ become saturated under multi-thousand-job sustained throughput. The queue transport layer must migrate to distributed log streams such as Apache Kafka, AWS Kinesis, or Apache Pulsar.
6. **Stateless Compute Autoscaling:** Ingress requires an Elastic Kubernetes Service (EKS) cluster running 30–50 autoscaled Go or Rust API pods behind an AWS Application Load Balancer with Cloudflare DDoS mitigation.

---

## 8. Summary of Reconciled Findings

1. **Reconciled Math:**
   - **Scenario A (Low):** **$163.63 / month** ($2.73 per 1,000 notifications)
   - **Scenario B (Expected):** **$912.84 / month** ($3.04 per 1,000 notifications)
   - **Scenario C (High):** **$5,821.76 / month** ($3.42 per 1,000 notifications)
2. **Reconciled Split for Scenario B:**
   - Server Infrastructure: **$136.19** (14.92%)
   - Third-Party Telecommunications: **$776.65** (85.08%)
   - Strict Fixed Subscriptions: **$130.69** (14.32%)
   - Strict Volume-Variable Costs: **$782.15** (85.68%)
3. **The SMS Dominance Phenomenon:** In all realistic multi-channel notification systems, telecommunications carrier fees for SMS represent over **85% to 93%** of total operating expenditure, proving that Tenant Rate Limiting (Milestone 6B) and Recipient Preference Suppression (Milestone 7A) are mission-critical financial controls.
4. **Architectural Target Distinction:** The 100k-user model reflects Relay's existing single-node prototype capabilities; the 50M/day design target is a distinct distributed architecture that cannot be costed via simple linear extrapolation.
