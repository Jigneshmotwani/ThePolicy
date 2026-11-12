import type { Desk } from "@config/sources";
import { getDb, getSetting, setSetting, type Db } from "@/lib/db";
import { env } from "@/lib/env";
import { fetchArticle, fetchPage } from "@/lib/article";
import { BudgetExceededError, makeBudget, withBudget, type Budget } from "@/lib/budget";
import { fetchFeed } from "@/lib/feeds";
import { assertModelsAvailable, pool, realLlm, type Llm } from "@/lib/llm";
import { oneLine, splitSentences, wordCount } from "@/lib/text";
import { checkDraft, copyDesk } from "./copyEditor";
import { deskSorter } from "./deskSorter";
import { factCheck, precheck } from "./factChecker";
import { outletsBehind, pressDecision, readPressRules } from "./pressRoom";
import { reviseDraft, ThinSheetError, writeDraft } from "./rewriteDesk";
import { runStep, setEventStatus, writeStep } from "./runlog";
import type { Ctx, Draft, EventRow, Fact } from "./types";
import { wireScout } from "./wireScout";

const MAX_STEP_FAILURES = 3;
const LOCK_STALE_MS = 45 * 60_000;

export interface SweepSummary {
  sweepId: number;
  newReports: number;
  eventsOpened: number;
  waiting: number;
  expired: number;
  /** Events taken through the desks this sweep. */
  taken: number;
  deferred: number;
  printed: number;
  held: number;
  spiked: number;
  backToWaiting: number;
  failed: number;
  /** True when the daily budget stopped model calls during (or before) this sweep. */
  budgetStopped: boolean;
  pressesStopped: boolean;
  promptTokens: number;
  completionTokens: number;
  llmCalls: number;
  costUsd: number;
  seconds: number;
  error?: string;
}

export type EventOutcome = "printed" | "held" | "spiked" | "waiting" | "failed" | "paused" | "taken";

/** Take a waiting event for ourselves. False if someone else (another run, an editor) got there first. */
export function claimEvent(ctx: Pick<Ctx, "db" | "now">, eventId: number): boolean {
  return setEventStatus(ctx, eventId, "working", null, "On the desks", {}, "waiting");
}

/** Take one qualified, claimed event from fact check to the press. */
export async function processEvent(ctx: Ctx, ev: EventRow): Promise<EventOutcome> {
  const { db } = ctx;
  // An editor can hold or spike a story while it is on the desks; if so, we stop and leave their decision alone.
  const ours = () => (db.prepare("SELECT status FROM events WHERE id = ?").get(ev.id) as { status: string }).status === "working";
  try {
    /* 3. Fact Checker */
    const checked = await runStep(ctx, "Fact Checker", ev.id, async (meter) => {
      const out = await factCheck(ctx, ev, meter);
      return { note: out.kind === "ready" || out.kind === "waiting" || out.kind === "expired" ? out.note : "No change", value: out };
    });
    if (checked.kind !== "ready") {
      setEventStatus(ctx, ev.id, "waiting", null, checked.kind === "waiting" ? checked.note : "Waiting", {}, "working");
      return "waiting";
    }
    if (!ours()) return "taken";
    const facts: Fact[] = checked.facts;
    const disputed = checked.disputed;
    const desk = ev.desk as Desk;

    /* 4. Rewrite Desk */
    const thin = (e: ThinSheetError) => `The ${facts.length} agreed facts are too thin for a 45-word item (best was ${e.words} words without padding); the story waits for more corroborated detail`;
    const first = await runStep(ctx, "Rewrite Desk", ev.id, async (meter) => {
      try {
        const d = await writeDraft(ctx.llm, meter, desk, facts, disputed);
        return { note: `Wrote "${d.headline}" (${d.headline.length} chars) and a ${wordCount(d.body)}-word body from ${facts.length} facts`, value: d as Draft | null };
      } catch (e) {
        if (!(e instanceof ThinSheetError)) throw e;
        return { note: thin(e), value: null };
      }
    });
    if (!first) {
      // Hold rather than pad. A new report makes the facts stale again and the story gets another go.
      setEventStatus(ctx, ev.id, "waiting", "thin_sheet", "Waiting: outlets agree on too little to write a full item; needs more corroborated detail", {}, "working");
      return "waiting";
    }

    /* 5. Copy Editor (one rewrite allowed) */
    const edited = await copyDesk(first, {
      check: (draft, pass) =>
        runStep(ctx, "Copy Editor", ev.id, async (meter) => {
          const problems = await checkDraft(ctx.llm, meter, facts, draft, disputed);
          const n = splitSentences(draft.body).length + 1;
          const note = !problems.length
            ? `${pass === 2 ? "After the rewrite, all" : "All"} ${n} sentences are supported by the fact sheet`
            : `${problems.length} of ${n} sentences unsupported (${oneLine(problems[0].problem, 110)}); ` +
              (pass === 1 ? "sent back for one rewrite" : "still unsupported after the rewrite, story spiked");
          return { note, value: problems };
        }),
      rewrite: (draft, problems) =>
        runStep(ctx, "Rewrite Desk", ev.id, async (meter) => {
          try {
            const d = await reviseDraft(ctx.llm, meter, desk, facts, draft, problems, disputed);
            return { note: `Rewrote the copy to fix ${problems.length} unsupported sentence${problems.length > 1 ? "s" : ""}: "${d.headline}"`, value: d };
          } catch (e) {
            if (!(e instanceof ThinSheetError)) throw e;
            // Without the unsupported part there is not enough left to print: the Copy Editor's verdict stands.
            return { note: `Could not fix it: without the unsupported part ${thin(e).replace(/^The/, "the")}`, value: draft };
          }
        }),
    });
    if (!ours()) return "taken";
    if (edited.outcome === "spiked") {
      setEventStatus(ctx, ev.id, "spiked", "unsupported_copy",
        `Spiked by the Copy Editor: "${oneLine(edited.problems[0].sentence, 90)}" is not supported by the fact sheet`, {}, "working");
      return "spiked";
    }

    const iso = ctx.now().toISOString();
    db.prepare(
      `INSERT INTO angles (event_id, angle_key, label, body, word_count, created_at) VALUES (?, 'general', 'General', ?, ?, ?)
       ON CONFLICT(event_id, angle_key) DO UPDATE SET body = excluded.body, word_count = excluded.word_count, created_at = excluded.created_at`,
    ).run(ev.id, edited.draft.body, wordCount(edited.draft.body), iso);
    db.prepare("UPDATE events SET headline = ? WHERE id = ?").run(edited.draft.headline, ev.id);

    /* 6. Picture Desk */
    await runStep(ctx, "Picture Desk", ev.id, async () => ({
      status: "skipped" as const,
      note: "Skipped: the Picture Desk is not built yet; the story runs with the image placeholder",
      value: null,
    }));

    /* 7. Press Room */
    return await runStep(ctx, "Press Room", ev.id, async () => {
      // Last line of defence, independent of everything upstream: recount the
      // outlets behind the fact sheet straight from the database.
      const q = outletsBehind(db, ev.id);
      if (!q.ok) throw new Error(`refused to print: ${q.reason}`);

      const rules = readPressRules(db, desk);
      const decision = pressDecision(rules.pressesStopped, rules.rule);
      if (decision.action === "print") {
        const done = setEventStatus(ctx, ev.id, "printed", null, `Printed with ${q.count} outlets behind it`, {
          printed_at: ctx.now().toISOString(), outlet_count: q.count,
        }, "working");
        if (!done) return { note: "Not printed: an editor moved the story while it was on the desks", value: "taken" as const };
        return { note: `${decision.note}; ${q.count} independent outlets behind the fact sheet`, value: "printed" as const };
      }
      const done = setEventStatus(ctx, ev.id, "held", decision.reason, decision.note, { outlet_count: q.count }, "working");
      return { note: done ? decision.note : "An editor moved the story while it was on the desks", value: done ? ("held" as const) : ("taken" as const) };
    });
  } catch (e) {
    const msg = oneLine((e as Error)?.message ?? String(e), 160);
    if (e instanceof BudgetExceededError) {
      // Not the story's fault: back in the queue, untouched, for tomorrow.
      setEventStatus(ctx, ev.id, "waiting", "budget", "Paused: the daily budget was reached; resumes after midnight IST", { facts_stale: 1 }, "working");
      return "paused";
    }
    const fails = ev.fail_count + 1;
    if (fails >= MAX_STEP_FAILURES) {
      setEventStatus(ctx, ev.id, "spiked", "step_failed", `Spiked after ${fails} failed attempts: ${msg}`, { fail_count: fails }, "working");
    } else {
      setEventStatus(ctx, ev.id, "waiting", "step_failed", `A step failed (${msg}); will retry next sweep`, { fail_count: fails, facts_stale: 1 }, "working");
    }
    ctx.log(`  event ${ev.id}: step failed (${msg})`);
    return "failed";
  }
}

/** One sweep at a time. The lock names its process, so a killed sweep does not block the next. */
function acquireLock(db: Db, now: Date): boolean {
  const cur = getSetting(db, "sweep_lock");
  if (cur) {
    const [pid, at] = cur.split("|");
    let alive = false;
    try {
      process.kill(Number(pid), 0);
      alive = Number(pid) !== process.pid;
    } catch {
      alive = false;
    }
    if (alive && now.getTime() - new Date(at).getTime() < LOCK_STALE_MS) return false;
  }
  setSetting(db, "sweep_lock", `${process.pid}|${now.toISOString()}`);
  return true;
}

export interface RunOptions extends Partial<Omit<Ctx, "sweepId">> {
  skipModelCheck?: boolean;
  /** Shared across sweeps and submissions in one worker process. */
  budget?: Budget;
}

/** Build the context a stage runs in. The model is always behind the daily budget. */
export function makeCtx(opts: RunOptions, sweepId: number | null): Ctx & { budget: Budget } {
  const db = opts.db ?? getDb();
  const now = opts.now ?? (() => new Date());
  const budget = opts.budget ?? makeBudget(db, now);
  const llm: Llm = withBudget(opts.llm ?? realLlm(), budget);
  return {
    db, now, sweepId, llm, budget,
    log: opts.log ?? ((l: string) => console.log(l)),
    fetchFeed: opts.fetchFeed ?? ((url) => fetchFeed(db, url)),
    fetchArticle: opts.fetchArticle ?? fetchArticle,
    fetchPage: opts.fetchPage ?? fetchPage,
  };
}

/** Stories left "working" by a process that died go back in the queue. Call once when a worker starts. */
export function recoverInterrupted(db: Db): number {
  return Number(
    db
      .prepare(
        "UPDATE events SET status = 'waiting', facts_stale = 1, current_agent = NULL, status_note = 'Returned to the queue after an interrupted run' WHERE status = 'working'",
      )
      .run().changes,
  );
}

/** One full pass of the pipeline. Returns null if another sweep holds the lock. */
export async function sweep(overrides: RunOptions = {}): Promise<SweepSummary | null> {
  const db = overrides.db ?? getDb();
  const now = overrides.now ?? (() => new Date());
  const log = overrides.log ?? ((l: string) => console.log(l));
  if (!acquireLock(db, now())) {
    log("Another sweep is still running; skipping this one.");
    return null;
  }
  const t0 = Date.now();
  const sweepId = Number(db.prepare("INSERT INTO sweeps (started_at) VALUES (?)").run(now().toISOString()).lastInsertRowid);
  const summary: SweepSummary = {
    sweepId, newReports: 0, eventsOpened: 0, waiting: 0, expired: 0, taken: 0, deferred: 0, printed: 0, held: 0, spiked: 0,
    backToWaiting: 0, failed: 0, budgetStopped: false, pressesStopped: false, promptTokens: 0, completionTokens: 0, llmCalls: 0, costUsd: 0, seconds: 0,
  };
  try {
    const ctx = makeCtx({ ...overrides, log }, sweepId);
    ctx.budget.sync();
    const iso0 = now().toISOString();

    log(`Sweep ${sweepId}: Wire Scout reading feeds...`);
    const scout = await wireScout(ctx).catch((e) => (log(`  Wire Scout failed: ${e.message}`), { stored: 0 }));
    summary.newReports = scout.stored;

    // The daily cap: reports keep coming in, but nothing that needs the model runs.
    if (ctx.budget.exhausted()) {
      summary.budgetStopped = true;
      const note = `Skipped: daily budget reached ($${ctx.budget.spent().toFixed(2)} of $${ctx.budget.cap.toFixed(2)}); no model calls until midnight IST`;
      writeStep(db, { sweepId, eventId: null, agent: "Desk Sorter", status: "skipped", startedAt: iso0, endedAt: now().toISOString(), note });
      log(`  ${scout.stored} new reports stored. ${note}`);
    } else {
      if (!overrides.llm && !overrides.skipModelCheck) await assertModelsAvailable();
      log(`  ${scout.stored} new reports. Desk Sorter grouping...`);
      const sorted = await deskSorter(ctx).catch((e) => (log(`  Desk Sorter failed: ${e.message}`), { opened: 0, joined: 0, discarded: 0, budgetStopped: false }));
      summary.eventsOpened = sorted.opened;
      summary.budgetStopped = sorted.budgetStopped;
      log(`  ${sorted.opened} events opened, ${sorted.joined} reports joined existing events, ${sorted.discarded} discarded.`);
    }

    /* Recheck everything that is waiting. No model, no network: this costs nothing. */
    const waitingEvents = db
      .prepare(
        // Editor submissions first, then the most recently reported: under the cap, fresh news wins.
        `SELECT e.*, (SELECT MAX(published_at) FROM reports r WHERE r.event_id = e.id) AS latest
         FROM events e WHERE e.status = 'waiting' ORDER BY e.priority DESC, latest DESC, e.id DESC`,
      )
      .all() as unknown as EventRow[];
    const queue: EventRow[] = [];
    const pressesStopped = getSetting(db, "presses_stopped") === "1";
    summary.pressesStopped = pressesStopped;
    const bump = db.prepare("UPDATE events SET recheck_count = recheck_count + 1, last_checked_at = ? WHERE id = ?");
    for (const ev of waitingEvents) {
      const iso = now().toISOString();
      const pre = precheck(ctx, ev);
      bump.run(iso, ev.id);
      if (pre.kind === "expired") {
        setEventStatus(ctx, ev.id, "spiked", pre.note.includes("before the desks") ? "expired_unprocessed" : "expired_unconfirmed", pre.note, {}, "waiting");
        writeStep(db, { sweepId, eventId: ev.id, agent: "Fact Checker", status: "ok", startedAt: iso, endedAt: iso, note: pre.note });
        summary.expired++;
      } else if (pre.kind === "waiting") {
        summary.waiting++;
        // One step when the picture changes, not one per sweep: the recheck
        // itself is recorded on the event (recheck_count, last_checked_at).
        if (pre.changed) {
          setEventStatus(ctx, ev.id, "waiting", null, pre.note, {}, "waiting");
          writeStep(db, { sweepId, eventId: ev.id, agent: "Fact Checker", status: "ok", startedAt: iso, endedAt: iso, note: pre.note });
        }
      } else if (pre.kind === "unchanged") {
        summary.waiting++;
      } else if (pre.kind === "go") {
        // Editor submissions (priority) are never capped; the rest are.
        if (!pressesStopped && !ctx.budget.exhausted() && (ev.priority > 0 || queue.length < env.maxEventsPerSweep)) queue.push(ev);
        else summary.deferred++;
      }
    }
    summary.taken = queue.length;
    const why = pressesStopped ? "the presses are stopped" : ctx.budget.exhausted() ? "daily budget reached" : "next sweep";
    log(`  ${summary.waiting} events waiting, ${summary.expired} expired, ${queue.length} qualified for the desks${summary.deferred ? ` (${summary.deferred} more deferred: ${why})` : ""}.`);

    const counts: Record<EventOutcome, number> = { printed: 0, held: 0, spiked: 0, waiting: 0, failed: 0, paused: 0, taken: 0 };
    await pool(queue, 6, async (ev) => {
      if (ctx.budget.exhausted()) {
        counts.paused++;
        return;
      }
      if (!claimEvent(ctx, ev.id)) {
        counts.taken++;
        return;
      }
      const outcome = await processEvent(ctx, ev);
      counts[outcome]++;
      const row = db.prepare("SELECT headline, status_note FROM events WHERE id = ?").get(ev.id) as { headline: string | null; status_note: string };
      log(`  [${outcome}] #${ev.id} ${oneLine(row.headline ?? ev.label, 70)}${outcome === "printed" ? "" : ` — ${oneLine(row.status_note, 110)}`}`);
    });
    Object.assign(summary, {
      printed: counts.printed, held: counts.held, spiked: counts.spiked, backToWaiting: counts.waiting, failed: counts.failed,
      waiting: summary.waiting + counts.waiting + counts.paused,
      deferred: summary.deferred + counts.paused,
      budgetStopped: summary.budgetStopped || counts.paused > 0 || ctx.budget.exhausted(),
    });
    return summary;
  } catch (e) {
    summary.error = oneLine((e as Error)?.message ?? String(e), 200);
    throw e;
  } finally {
    const usage = db
      .prepare("SELECT COALESCE(SUM(prompt_tokens),0) p, COALESCE(SUM(completion_tokens),0) c, COALESCE(SUM(llm_calls),0) n, COALESCE(SUM(cost_usd),0) usd FROM steps WHERE sweep_id = ?")
      .get(sweepId) as { p: number; c: number; n: number; usd: number };
    Object.assign(summary, {
      promptTokens: usage.p, completionTokens: usage.c, llmCalls: usage.n, costUsd: Math.round(usage.usd * 1e4) / 1e4,
      seconds: Math.round((Date.now() - t0) / 1000),
    });
    db.prepare("UPDATE sweeps SET ended_at = ?, summary = ? WHERE id = ?").run(now().toISOString(), JSON.stringify(summary), sweepId);
    db.prepare("DELETE FROM settings WHERE key = 'sweep_lock'").run();
    log(
      `Sweep ${sweepId} ${summary.error ? `FAILED (${summary.error})` : "done"} in ${summary.seconds}s: ${summary.printed} printed, ${summary.held} held, ${summary.spiked} spiked, ` +
      `${summary.failed} failed, ${summary.waiting} waiting. ${summary.llmCalls} model calls, ${summary.promptTokens} in / ${summary.completionTokens} out tokens, about $${summary.costUsd.toFixed(4)}.` +
      (summary.budgetStopped ? " Daily budget reached." : ""),
    );
  }
}
