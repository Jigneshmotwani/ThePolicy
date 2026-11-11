import { env } from "./lib/env";
import { sweep } from "./pipeline/sweep";

/**
 * The pipeline worker.
 *   npm run sweep    one sweep, then exit
 *   npm run worker   sweep every SWEEP_MINUTES until stopped
 */
const once = process.argv.includes("--once");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let stopping = false;
process.on("SIGINT", () => {
  if (stopping) process.exit(130);
  stopping = true;
  console.log("\nStopping after the current sweep (Ctrl-C again to stop now)...");
});

async function main() {
  do {
    try {
      await sweep();
    } catch (e) {
      console.error(`Sweep failed: ${(e as Error)?.message ?? e}`);
      if (once) process.exitCode = 1;
    }
    if (once || stopping) break;
    console.log(`Next sweep in ${env.sweepMinutes} minutes.`);
    for (let waited = 0; waited < env.sweepMinutes * 60_000 && !stopping; waited += 1000) await sleep(1000);
  } while (!stopping);
}

main();
