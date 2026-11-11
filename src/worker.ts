import { getDb, nowIso, setSetting } from "./lib/db";
import { env } from "./lib/env";
import { makeBudget, nextIstMidnight } from "./lib/budget";
import { listModels } from "./lib/llm";
import { processSubmission, queuedSubmissions } from "./pipeline/submissions";
import { makeCtx, recoverInterrupted, sweep } from "./pipeline/sweep";

/**
 * The pipeline worker.
 *   npm run sweep    one sweep, then exit
 *   npm run worker   sweep every SWEEP_MINUTES until stopped, and in between
 *                    answer the console within a few seconds: "sweep now"
 *                    requests and stories an editor sent to the desk.
 *
 * The console and the worker are separate processes; they talk only through
 * the database (worker_commands, submissions, and a heartbeat in settings).
 */
const once = process.argv.includes("--once");
const TICK_MS = 3000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const db = getDb();
  const budget = makeBudget(db, () => new Date());

  if (once) {
    try {
      await sweep({ budget });
    } catch (e) {
      console.error(`Sweep failed: ${(e as Error)?.message ?? e}`);
      process.exitCode = 1;
    }
    return;
  }

  let stopping = false;
  let sweeping = false;
  let busyWithSubmissions = false;
  let nextSweepAt = Date.now();
  let pausedLogged = "";
  const stop = () => {
    if (stopping) process.exit(130);
    stopping = true;
    console.log("\nStopping after the current sweep (signal again to stop now)...");
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  await listModels().catch(() => undefined); // prices, so every model call is costed from the first one
  const returned = recoverInterrupted(db);
  if (returned) console.log(`${returned} stories left on the desks by an interrupted run were returned to the queue.`);
  console.log(`Worker started (pid ${process.pid}). Sweeping every ${env.sweepMinutes} minutes; daily budget $${env.dailyBudgetUsd}.`);

  const heartbeat = () =>
    setSetting(db, "worker_heartbeat", JSON.stringify({
      pid: process.pid, at: nowIso(), state: sweeping ? "sweeping" : "idle",
      nextSweepAt: new Date(nextSweepAt).toISOString(), sweepMinutes: env.sweepMinutes,
    }));

  const runSweep = async (why: string) => {
    sweeping = true;
    nextSweepAt = Date.now() + env.sweepMinutes * 60_000; // start-to-start; never overlapping
    heartbeat();
    try {
      if (why) console.log(why);
      await sweep({ budget });
    } catch (e) {
      console.error(`Sweep failed: ${(e as Error)?.message ?? e}`);
    } finally {
      sweeping = false;
      if (nextSweepAt < Date.now()) nextSweepAt = Date.now(); // the sweep overran its slot: go again at once
      if (!stopping) console.log(`Next sweep at ${new Date(nextSweepAt).toISOString().slice(11, 19)} UTC.`);
    }
  };

  const runSubmissions = async () => {
    busyWithSubmissions = true;
    try {
      for (const sub of queuedSubmissions({ db })) {
        console.log(`Editor sent a ${sub.kind} to the desk: ${sub.input.slice(0, 100)}`);
        await processSubmission(makeCtx({ budget }, null), sub);
      }
    } catch (e) {
      console.error(`Submission handling failed: ${(e as Error)?.message ?? e}`);
    } finally {
      busyWithSubmissions = false;
    }
  };

  while (!stopping || sweeping || busyWithSubmissions) {
    heartbeat();
    if (!stopping) {
      // The console asked for a sweep now.
      const cmd = db.prepare("SELECT id FROM worker_commands WHERE kind = 'sweep_now' AND picked_at IS NULL ORDER BY id LIMIT 1").get() as { id: number } | undefined;
      if (cmd) {
        db.prepare("UPDATE worker_commands SET picked_at = ?, note = ? WHERE kind = 'sweep_now' AND picked_at IS NULL")
          .run(nowIso(), sweeping ? "A sweep was already running" : "Started");
        if (!sweeping) void runSweep("Sweep requested from the console.");
      } else if (!sweeping && Date.now() >= nextSweepAt) {
        void runSweep("");
      }
      // Stories an editor sent to the desk are handled at once, alongside any sweep.
      if (!busyWithSubmissions && queuedSubmissions({ db }).length) void runSubmissions();

      if (budget.exhausted()) {
        const until = nextIstMidnight(new Date()).toISOString();
        if (pausedLogged !== until) {
          pausedLogged = until;
          console.log(`Daily budget reached ($${budget.spent().toFixed(2)} of $${budget.cap}). Feeds are still read; no model calls until ${until}.`);
        }
      }
    }
    await sleep(TICK_MS);
  }
  setSetting(db, "worker_heartbeat", JSON.stringify({ pid: process.pid, at: nowIso(), state: "stopped" }));
  console.log("Worker stopped.");
}

main();
