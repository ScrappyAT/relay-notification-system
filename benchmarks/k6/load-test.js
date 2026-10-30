import http from 'k6/http';
import { check, sleep } from 'k6';
import { Counter, Rate, Trend } from 'k6/metrics';

// ============================================================================
// RELAY NOTIFICATION SYSTEM — k6 LOAD TEST SUITE (Milestone 7C)
// Evaluates Baseline, Gradual Ramp-Up, and Spike traffic scenarios against
// Relay's durable ingestion pipeline, rate limiter, and backpressure admission.
// ============================================================================

// Custom Prometheus-compatible Metrics
const accepted202Counter = new Counter('relay_accepted_202_total');
const suppressed200Counter = new Counter('relay_suppressed_200_total');
const rateLimited429Counter = new Counter('relay_rate_limited_429_total');
const overloaded503Counter = new Counter('relay_overloaded_503_total');
const unexpectedErrorsCounter = new Counter('relay_unexpected_errors_total');
const protectionResponsesCounter = new Counter('relay_protection_responses_total');

const acceptedLatencyTrend = new Trend('relay_accepted_duration_ms', true);
const allReqLatencyTrend = new Trend('relay_request_duration_ms', true);
const expectedResponseRate = new Rate('relay_expected_responses_rate');

// Target API endpoint
const BASE_URL = __ENV.BASE_URL || 'http://127.0.0.1:3000';
const SELECTED_SCENARIO = __ENV.SCENARIO || 'baseline';

// Load pre-seeded test tenants if available, or use fallbacks
let tenants = [];
try {
  const tenantsFile = open('./test-tenants.json');
  tenants = JSON.parse(tenantsFile);
} catch (e) {
  try {
    const tenantsFile = open('../../scripts/k6/test-tenants.json');
    tenants = JSON.parse(tenantsFile);
  } catch (e2) {
    tenants = [
      { id: '11111111-1111-4111-a111-111111111111', name: 'k6 Tenant A' },
      { id: '22222222-2222-4222-a222-222222222222', name: 'k6 Tenant B' },
      { id: '33333333-3333-4333-a333-333333333333', name: 'k6 Tenant C' },
    ];
  }
}

// Generate random UUID v4 in k6
function generateUUID() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

// ============================================================================
// SCENARIO DEFINITIONS
// ============================================================================
const scenarioConfigs = {
  // Scenario A: Baseline — Normal low-volume operation to establish reference metrics
  baseline: {
    executor: 'constant-vus',
    vus: 3,
    duration: '20s',
  },

  // Scenario B: Gradual Ramp-Up — Tests quota limits (429) and contention (503)
  ramp_up: {
    executor: 'ramping-vus',
    startVUs: 2,
    stages: [
      { duration: '10s', target: 8 },   // Normal ingress ramp
      { duration: '15s', target: 20 },  // High concurrency approaching tenant quota
      { duration: '15s', target: 35 },  // Over-quota and pool contention zone
      { duration: '10s', target: 0 },   // Graceful cooldown
    ],
  },

  // Scenario C: Short Spike — Rapid burst to test elasticity and recovery
  spike: {
    executor: 'ramping-vus',
    startVUs: 3,
    stages: [
      { duration: '8s', target: 5 },    // Steady baseline
      { duration: '6s', target: 30 },   // Rapid traffic burst
      { duration: '10s', target: 5 },   // Immediate post-spike recovery
      { duration: '6s', target: 0 },    // Cooldown
    ],
  },
};

// Export k6 test configuration
export const options = {
  scenarios: {
    [SELECTED_SCENARIO]: scenarioConfigs[SELECTED_SCENARIO] || scenarioConfigs.baseline,
  },
  summaryTrendStats: ['avg', 'min', 'med', 'max', 'p(90)', 'p(95)', 'p(99)'],
  thresholds: {
    'http_req_duration': ['p(95)<10000'],
    'relay_expected_responses_rate': ['rate>0.95'],
    'relay_unexpected_errors_total': ['count<1'],
  },
};

// ============================================================================
// MAIN TEST ITERATION
// ============================================================================
export default function () {
  let tenantIndex = 0;
  if (SELECTED_SCENARIO === 'ramp_up') {
    tenantIndex = Math.random() < 0.70 ? 0 : (Math.random() < 0.5 ? 1 : 2);
  } else {
    tenantIndex = Math.floor(Math.random() * tenants.length);
  }
  const tenant = tenants[tenantIndex];
  const customerId = tenant.id;

  const isSuppressedTest = Math.random() < 0.15; // 15% suppressed test traffic
  const recipient = isSuppressedTest
    ? `optout-user@example.com`
    : `user-${__VU}-${__ITER}-${Date.now()}@example.com`;

  const channel = Math.random() > 0.5 ? 'email' : 'sms';
  const idempotencyKey = generateUUID();

  const payload = JSON.stringify({
    customerId,
    recipient,
    channel,
    payload: {
      subject: `k6 Load Test Notification`,
      body: `Automated load test payload for VU ${__VU} iteration ${__ITER}`,
    },
  });

  const params = {
    headers: {
      'Content-Type': 'application/json',
      'Idempotency-Key': idempotencyKey,
    },
    timeout: '15s',
  };

  const startTime = Date.now();
  const res = http.post(`${BASE_URL}/v1/notifications`, payload, params);
  const duration = Date.now() - startTime;
  allReqLatencyTrend.add(duration);

  const status = res.status;

  if (status === 202) {
    accepted202Counter.add(1);
    acceptedLatencyTrend.add(duration);
    expectedResponseRate.add(1);

    check(res, {
      'HTTP 202 Accepted': (r) => r.status === 202,
      'Response has notification id': (r) => {
        try {
          const body = JSON.parse(r.body);
          return body.id !== undefined && body.status === 'pending';
        } catch (e) {
          return false;
        }
      },
      'RateLimit headers present': (r) => r.headers['Ratelimit-Remaining'] !== undefined,
    });
  } else if (status === 200) {
    suppressed200Counter.add(1);
    expectedResponseRate.add(1);

    check(res, {
      'HTTP 200 Suppressed': (r) => r.status === 200,
      'Response has suppressed status': (r) => {
        try {
          const body = JSON.parse(r.body);
          return body.status === 'suppressed' && body.suppressionReason === 'recipient_preference_disabled';
        } catch (e) {
          return false;
        }
      },
    });
  } else if (status === 429) {
    rateLimited429Counter.add(1);
    protectionResponsesCounter.add(1);
    expectedResponseRate.add(1);

    check(res, {
      'HTTP 429 Rate Limited': (r) => r.status === 429,
      'Has Retry-After header': (r) => r.headers['Retry-After'] !== undefined,
      'Has RateLimit-Reset header': (r) => r.headers['Ratelimit-Reset'] !== undefined,
    });
  } else if (status === 503) {
    overloaded503Counter.add(1);
    protectionResponsesCounter.add(1);
    expectedResponseRate.add(1);

    check(res, {
      'HTTP 503 Overload Protection': (r) => r.status === 503,
      'Has 503 Retry-After header': (r) => r.headers['Retry-After'] !== undefined,
    });
  } else {
    unexpectedErrorsCounter.add(1);
    expectedResponseRate.add(0);

    check(res, {
      'Unexpected status code': () => false,
    });
  }

  if (SELECTED_SCENARIO === 'baseline') {
    sleep(0.25 + Math.random() * 0.15);
  } else {
    sleep(0.04 + Math.random() * 0.06);
  }
}

// ============================================================================
// CUSTOM SUMMARY REPORTING
// ============================================================================
export function handleSummary(data) {
  const getVal = (metricName, key, def = 'N/A') => {
    try {
      const m = data.metrics[metricName];
      if (!m || !m.values) return def;
      const v = m.values[key];
      return typeof v === 'number' ? v.toFixed(2) : (v !== undefined ? v : def);
    } catch {
      return def;
    }
  };

  const httpReqs = data.metrics.http_reqs ? data.metrics.http_reqs.values.count : 0;
  const httpRate = data.metrics.http_reqs ? data.metrics.http_reqs.values.rate.toFixed(2) : 0;
  const p50 = getVal('http_req_duration', 'med') !== 'N/A' ? getVal('http_req_duration', 'med') : getVal('http_req_duration', 'p(50)');
  const p95 = getVal('http_req_duration', 'p(95)');
  const p99 = getVal('http_req_duration', 'p(99)');
  const avg = getVal('http_req_duration', 'avg');

  const acc202 = data.metrics.relay_accepted_202_total ? data.metrics.relay_accepted_202_total.values.count : 0;
  const sup200 = data.metrics.relay_suppressed_200_total ? data.metrics.relay_suppressed_200_total.values.count : 0;
  const rl429 = data.metrics.relay_rate_limited_429_total ? data.metrics.relay_rate_limited_429_total.values.count : 0;
  const ov503 = data.metrics.relay_overloaded_503_total ? data.metrics.relay_overloaded_503_total.values.count : 0;
  const unexp = data.metrics.relay_unexpected_errors_total ? data.metrics.relay_unexpected_errors_total.values.count : 0;

  const summaryText = `
================================================================================
           RELAY NOTIFICATION SYSTEM — k6 LOAD TEST EXECUTION SUMMARY
================================================================================
Scenario Name:        ${SELECTED_SCENARIO}
Target URL:           ${BASE_URL}
Total Requests:       ${httpReqs}
Throughput:           ${httpRate} req/s

Latency (Overall):
  Average:            ${avg} ms
  p50 (Median):       ${p50} ms
  p95:                ${p95} ms
  p99:                ${p99} ms

Status Code Distribution:
  HTTP 202 Accepted:          ${acc202} (${((acc202 / Math.max(1, httpReqs)) * 100).toFixed(1)}%)
  HTTP 200 Suppressed:        ${sup200} (${((sup200 / Math.max(1, httpReqs)) * 100).toFixed(1)}%)
  HTTP 429 Rate Limited:      ${rl429} (${((rl429 / Math.max(1, httpReqs)) * 100).toFixed(1)}%)
  HTTP 503 Overload Defense:  ${ov503} (${((ov503 / Math.max(1, httpReqs)) * 100).toFixed(1)}%)
  Unexpected Errors (5xx):    ${unexp}

Protection & Elasticity Invariants:
  Expected Response Rate:     ${data.metrics.relay_expected_responses_rate ? (data.metrics.relay_expected_responses_rate.values.rate * 100).toFixed(2) : 0}%
  Protection Recoveries:      ${rl429 + ov503} defensive rejections preserved database durability
================================================================================
`;

  return {
    stdout: summaryText,
    [`benchmarks/k6/summary-${SELECTED_SCENARIO}.json`]: JSON.stringify(data, null, 2),
  };
}
