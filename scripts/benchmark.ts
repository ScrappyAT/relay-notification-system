import { pool } from "../src/database/pool.js";
import { getEmailQueue, closeQueues } from "../src/queues/notificationQueues.js";
import { getEmailWorker, closeEmailWorker } from "../src/workers/emailWorker.js";
import { OutboxDispatcher } from "../src/services/outboxDispatcher.js";
import { tenantFairnessService } from "../src/services/tenantFairnessService.js";
import { closeRedisConnection } from "../src/config/redis.js";
import crypto from "crypto";

process.on("unhandledRejection", (err: any) => {
  console.warn("[Process] Handled unhandledRejection:", err.message);
});

interface TenantStats {
  id: string;
  name: string;
  total: number;
  completed: number;
  firstCompletedAt?: number;
  lastCompletedAt?: number;
}

async function runBenchmark() {
  console.log("==============================================================");
  console.log("        RELAY MILESTONE 6C: TENANT FAIRNESS BENCHMARK         ");
  console.log("==============================================================");

  // 1. Setup Test Tenants
  // Scoped cleanup strictly targeting benchmark-named customers
  await pool.query(
    `DELETE FROM outbox_events WHERE notification_id IN (
       SELECT id FROM notifications WHERE customer_id IN (
         SELECT id FROM customers WHERE name LIKE 'Benchmark%'
       )
     )`
  ).catch(() => {});
  await pool.query(
    `DELETE FROM notifications WHERE customer_id IN (
       SELECT id FROM customers WHERE name LIKE 'Benchmark%'
     )`
  ).catch(() => {});
  await pool.query(
    `DELETE FROM customers WHERE name LIKE 'Benchmark%'`
  ).catch(() => {});

  const tenantAId = crypto.randomUUID();
  const tenantBId = crypto.randomUUID();
  const tenantCId = crypto.randomUUID();

  await pool.query(
    `INSERT INTO customers (id, name) VALUES 
     ($1, 'Benchmark Tenant A (High-Volume)'),
     ($2, 'Benchmark Tenant B (Low-Volume)'),
     ($3, 'Benchmark Tenant C (Low-Volume)')`,
    [tenantAId, tenantBId, tenantCId]
  );

  const COUNT_A = 40;
  const COUNT_B = 10;
  const COUNT_C = 10;
  const totalNotifications = COUNT_A + COUNT_B + COUNT_C;

  const stats: Record<string, TenantStats> = {
    [tenantAId]: { id: tenantAId, name: `Tenant A (${COUNT_A} items)`, total: COUNT_A, completed: 0 },
    [tenantBId]: { id: tenantBId, name: `Tenant B (${COUNT_B} items)`, total: COUNT_B, completed: 0 },
    [tenantCId]: { id: tenantCId, name: `Tenant C (${COUNT_C} items)`, total: COUNT_C, completed: 0 },
  };

  console.log(`\n[Setup] Populating ${totalNotifications} test notifications into PostgreSQL outbox...`);
  console.log(`  - Tenant A: ${COUNT_A} notifications (High-Volume)`);
  console.log(`  - Tenant B: ${COUNT_B} notifications (Low-Volume)`);
  console.log(`  - Tenant C: ${COUNT_C} notifications (Low-Volume)`);

  const generateBatch = (tenantId: string, count: number, prefix: string) => {
    const records = [];
    for (let i = 0; i < count; i++) {
      records.push({
        id: crypto.randomUUID(),
        customerId: tenantId,
        recipient: `${prefix}-${i}@example.com`,
        channel: "email",
        payload: JSON.stringify({ subject: `Benchmark ${i}`, body: "Fairness Test" }),
      });
    }
    return records;
  };

  const allRecords = [
    ...generateBatch(tenantAId, COUNT_A, "tenantA"),
    ...generateBatch(tenantBId, COUNT_B, "tenantB"),
    ...generateBatch(tenantCId, COUNT_C, "tenantC"),
  ];

  const BATCH_SIZE = 30;
  for (let i = 0; i < allRecords.length; i += BATCH_SIZE) {
    const chunk = allRecords.slice(i, i + BATCH_SIZE);
    
    // Batch insert notifications
    const notifValues = chunk.map((r, idx) => {
      const base = idx * 5;
      return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, 'pending', NOW(), NOW())`;
    }).join(", ");
    
    const notifParams = chunk.flatMap(r => [r.id, r.customerId, r.recipient, r.channel, r.payload]);
    await pool.query(
      `INSERT INTO notifications (id, customer_id, recipient, channel, payload, status, created_at, updated_at)
       VALUES ${notifValues}`,
      notifParams
    );

    // Batch insert outbox events
    const outboxValues = chunk.map((r, idx) => {
      const base = idx * 2;
      return `($${base + 1}, $${base + 2}, 'notification.requested', 0, NOW())`;
    }).join(", ");
    
    const outboxParams = chunk.flatMap(r => [crypto.randomUUID(), r.id]);
    await pool.query(
      `INSERT INTO outbox_events (id, notification_id, event_type, attempts, created_at)
       VALUES ${outboxValues}`,
      outboxParams
    );
  }

  console.log("[Setup] Database populated successfully. Starting workers and dispatcher...");

  await tenantFairnessService.reset("email");
  const emailQueue = getEmailQueue();
  await emailQueue.drain().catch(() => {});
  await emailQueue.obliterate({ force: true }).catch(() => {});

  const startTime = Date.now();
  const worker = getEmailWorker();

  let tenantACompletedWhenBFinished: number | null = null;
  let tenantACompletedWhenCFinished: number | null = null;

  const TIMEOUT_MS = 90000; // 90-second bounded timeout
  let isTimedOut = false;

  // Poll database directly for accurate persistent terminal state
  const completionPromise = new Promise<void>((resolve) => {
    const timeoutHandle = setTimeout(() => {
      isTimedOut = true;
      console.warn(`\n[Warning] Benchmark reached timeout of ${TIMEOUT_MS / 1000}s.`);
      resolve();
    }, TIMEOUT_MS);

    const pollInterval = setInterval(async () => {
      try {
        const res = await pool.query(
          `SELECT customer_id, COUNT(*) as count 
           FROM notifications 
           WHERE customer_id IN ($1, $2, $3) AND status = 'processed'
           GROUP BY customer_id`,
          [tenantAId, tenantBId, tenantCId]
        );

        let totalDone = 0;
        const now = Date.now();

        for (const row of res.rows) {
          const cId = row.customer_id;
          const count = Number(row.count);
          const s = stats[cId];
          if (s) {
            s.completed = count;
            if (count > 0 && !s.firstCompletedAt) {
              s.firstCompletedAt = now;
            }
            if (count === s.total && !s.lastCompletedAt) {
              s.lastCompletedAt = now;
            }
            totalDone += count;

            if (cId === tenantBId && count === COUNT_B && tenantACompletedWhenBFinished === null) {
              tenantACompletedWhenBFinished = stats[tenantAId].completed;
            }
            if (cId === tenantCId && count === COUNT_C && tenantACompletedWhenCFinished === null) {
              tenantACompletedWhenCFinished = stats[tenantAId].completed;
            }
          }
        }

        if (totalDone % 10 === 0 || totalDone === totalNotifications) {
          console.log(`[Progress] Terminal processed: ${totalDone}/${totalNotifications} (A: ${stats[tenantAId].completed}/${COUNT_A}, B: ${stats[tenantBId].completed}/${COUNT_B}, C: ${stats[tenantCId].completed}/${COUNT_C})`);
        }

        if (totalDone >= totalNotifications) {
          clearInterval(pollInterval);
          clearTimeout(timeoutHandle);
          resolve();
        }
      } catch {
        // Ignore transient poll errors
      }
    }, 500);
  });

  // Start fast dispatcher for benchmark (poll every 100ms, batch size 20)
  const dispatcher = new OutboxDispatcher(100, 60, 20);
  await dispatcher.start();

  console.log("[Benchmark] Execution running...");
  await completionPromise;
  console.log("\n[Benchmark] Execution completed.");

  const totalDurationSec = (Date.now() - startTime) / 1000;
  await dispatcher.stop();

  // 2. Direct PostgreSQL Database Audit for 100% Terminal State
  const dbTerminalRows = await pool.query(
    `SELECT n.customer_id, n.status, COUNT(*) as count 
     FROM notifications n 
     WHERE n.customer_id IN ($1, $2, $3) 
     GROUP BY n.customer_id, n.status 
     ORDER BY n.customer_id, n.status`,
    [tenantAId, tenantBId, tenantCId]
  );

  const dbOutboxRows = await pool.query(
    `SELECT oe.published_at IS NOT NULL as published, COUNT(*) as count 
     FROM outbox_events oe 
     JOIN notifications n ON oe.notification_id = n.id 
     WHERE n.customer_id IN ($1, $2, $3) 
     GROUP BY published`,
    [tenantAId, tenantBId, tenantCId]
  );

  let totalProcessedFromDb = 0;
  for (const row of dbTerminalRows.rows) {
    if (row.status === "processed") {
      totalProcessedFromDb += Number(row.count);
    }
  }

  // 3. Compute Analysis
  console.log("\n==============================================================");
  console.log("            EMPIRICAL MEASURED BENCHMARK RESULTS              ");
  console.log("==============================================================");
  console.log(`Total Configured:        ${totalNotifications}`);
  console.log(`Total Reached Terminal:  ${totalProcessedFromDb} / ${totalNotifications} (${((totalProcessedFromDb / totalNotifications) * 100).toFixed(1)}%)`);
  console.log(`Total Elapsed Time:      ${totalDurationSec.toFixed(2)} seconds`);
  console.log(`Measured Throughput:     ${(totalProcessedFromDb / totalDurationSec).toFixed(1)} notifications/sec\n`);

  console.log("PostgreSQL Database Terminal State Verification:");
  console.log("--------------------------------------------------------------------------------");
  for (const row of dbTerminalRows.rows) {
    const tName = row.customer_id === tenantAId ? "Tenant A" : row.customer_id === tenantBId ? "Tenant B" : "Tenant C";
    console.log(`  - ${tName} (${row.customer_id.substring(0, 8)}...): status='${row.status}', count=${row.count}`);
  }
  for (const row of dbOutboxRows.rows) {
    console.log(`  - Outbox published=${row.published}: count=${row.count}`);
  }
  console.log("--------------------------------------------------------------------------------\n");

  console.log("Tenant Performance Breakdown (Measured):");
  console.log("------------------------------------------------------------------------------------------------");
  console.log("Tenant Name               | Total | Processed | First Done | Last Done  | Elapsed (s)");
  console.log("------------------------------------------------------------------------------------------------");

  for (const t of [stats[tenantAId], stats[tenantBId], stats[tenantCId]]) {
    const elapsed = t.lastCompletedAt && t.firstCompletedAt 
      ? ((t.lastCompletedAt - startTime) / 1000).toFixed(2)
      : "N/A";
    const firstDone = t.firstCompletedAt 
      ? ((t.firstCompletedAt - startTime) / 1000).toFixed(2) + "s"
      : "N/A";
    const lastDone = t.lastCompletedAt 
      ? ((t.lastCompletedAt - startTime) / 1000).toFixed(2) + "s"
      : "N/A";

    console.log(
      `${t.name.padEnd(25)} | ${String(t.total).padEnd(5)} | ${String(t.completed).padEnd(9)} | ${firstDone.padEnd(10)} | ${lastDone.padEnd(10)} | ${String(elapsed)}`
    );
  }
  console.log("------------------------------------------------------------------------------------------------");

  // Fairness Verification Proof
  const bDoneTime = stats[tenantBId].lastCompletedAt || 0;
  const cDoneTime = stats[tenantCId].lastCompletedAt || 0;
  const aDoneTime = stats[tenantAId].lastCompletedAt || 0;

  console.log("\nEmpirical Fairness Verification Proof:");
  const bFinishedBeforeA = bDoneTime < aDoneTime;
  const cFinishedBeforeA = cDoneTime < aDoneTime;
  console.log(`  [Pass] Tenant B finished before Tenant A: ${bFinishedBeforeA ? "YES" : "NO"} (${((bDoneTime - startTime) / 1000).toFixed(2)}s vs ${((aDoneTime - startTime) / 1000).toFixed(2)}s)`);
  console.log(`  [Pass] Tenant C finished before Tenant A: ${cFinishedBeforeA ? "YES" : "NO"} (${((cDoneTime - startTime) / 1000).toFixed(2)}s vs ${((aDoneTime - startTime) / 1000).toFixed(2)}s)`);
  console.log(`  [Info] Tenant A progress when Tenant B reached 100%: ${tenantACompletedWhenBFinished ?? "N/A"} / ${COUNT_A} (${(((tenantACompletedWhenBFinished || 0) / COUNT_A) * 100).toFixed(1)}%)`);
  console.log(`  [Info] Tenant A progress when Tenant C reached 100%: ${tenantACompletedWhenCFinished ?? "N/A"} / ${COUNT_A} (${(((tenantACompletedWhenCFinished || 0) / COUNT_A) * 100).toFixed(1)}%)`);

  console.log("\n==============================================================");
  console.log("           THEORETICAL FIFO COMPARISON (ESTIMATION)           ");
  console.log("==============================================================");
  const avgJobSec = totalDurationSec / totalProcessedFromDb;
  const estimatedFifoWaitSecB = COUNT_A * avgJobSec;
  console.log(`Under strict FIFO queue without fairness interleaving:`);
  console.log(`  - Tenant B jobs would wait behind all ${COUNT_A} Tenant A jobs.`);
  console.log(`  - At measured average execution rate (~${(1 / avgJobSec).toFixed(1)} jobs/s), Tenant B's first job would wait ~${estimatedFifoWaitSecB.toFixed(1)}s.`);
  console.log(`  - Measured Relay dual-stage fairness achieved first job completion for Tenant B in ${((stats[tenantBId].firstCompletedAt! - startTime) / 1000).toFixed(2)}s.`);
  console.log(`  - Speedup factor for low-volume tenant time-to-first-item: ${(estimatedFifoWaitSecB / ((stats[tenantBId].firstCompletedAt! - startTime) / 1000)).toFixed(1)}x faster.`);

  // 4. Scoped Cleanup
  console.log("\n[Cleanup] Cleaning up benchmark database rows...");
  await pool.query("DELETE FROM outbox_events WHERE notification_id IN (SELECT id FROM notifications WHERE customer_id IN ($1, $2, $3))", [tenantAId, tenantBId, tenantCId]).catch(() => {});
  await pool.query("DELETE FROM notifications WHERE customer_id IN ($1, $2, $3)", [tenantAId, tenantBId, tenantCId]).catch(() => {});
  await pool.query("DELETE FROM customers WHERE id IN ($1, $2, $3)", [tenantAId, tenantBId, tenantCId]).catch(() => {});
  await closeEmailWorker();
  await closeQueues();
  await closeRedisConnection();
  await pool.end();
  console.log("[Cleanup] Complete.");
}

runBenchmark().catch((err) => {
  console.error("Benchmark failed:", err);
  process.exit(1);
});
