import type { Db } from "./db";
import { env } from "./env";
import { Meter, type JsonRequest, type Llm } from "./llm";

/**
 * The daily spend cap. "Today" runs midnight to midnight IST. Spend is what
 * the run log says the model calls cost (ai&'s listed prices), plus calls
 * made by this process whose step has not been written yet.
 */

const IST_OFFSET_MS = 5.5 * 3600_000;

/** The UTC instant at which the current IST day began. */
export function istDayStart(now: Date): Date {
  const ist = new Date(now.getTime() + IST_OFFSET_MS);
  return new Date(Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate()) - IST_OFFSET_MS);
}

export const nextIstMidnight = (now: Date): Date => new Date(istDayStart(now).getTime() + 24 * 3600_000);

export function spentToday(db: Db, now: Date): number {
  const row = db
    .prepare("SELECT COALESCE(SUM(cost_usd), 0) AS usd FROM steps WHERE started_at >= ?")
    .get(istDayStart(now).toISOString()) as { usd: number };
  return row.usd;
}

export class BudgetExceededError extends Error {
  constructor(spent: number, cap: number) {
    super(`Daily budget reached (${spent.toFixed(2)} of ${cap.toFixed(2)} USD): no model calls until midnight IST`);
    this.name = "BudgetExceededError";
  }
}

export interface Budget {
  cap: number;
  spent(): number;
  exhausted(): boolean;
  /** Re-read the run log (start of a sweep, or a new IST day). */
  sync(): void;
  add(usd: number): void;
}

export function makeBudget(db: Db, now: () => Date, cap = env.dailyBudgetUsd): Budget {
  let day = istDayStart(now()).getTime();
  let total = spentToday(db, now());
  const roll = () => {
    const today = istDayStart(now()).getTime();
    if (today !== day) {
      day = today;
      total = spentToday(db, now());
    }
  };
  return {
    cap,
    spent: () => (roll(), total),
    exhausted: () => (roll(), total >= cap),
    // Never lower than what this process has itself counted (in-flight steps are not in the log yet).
    sync: () => {
      roll();
      total = Math.max(total, spentToday(db, now()));
    },
    add: (usd) => {
      roll();
      total += usd;
    },
  };
}

/** Wrap a model so that it refuses to make calls once the cap is reached. */
export function withBudget(llm: Llm, budget: Budget): Llm {
  return {
    async json<T>(req: JsonRequest<T>): Promise<T> {
      if (budget.exhausted()) throw new BudgetExceededError(budget.spent(), budget.cap);
      const own = new Meter(); // per call, so concurrent calls sharing a step's meter are not double-counted
      try {
        return await llm.json({ ...req, meter: own });
      } finally {
        budget.add(own.costUsd);
        req.meter.absorb(own);
      }
    },
  };
}
