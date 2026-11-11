import type { Desk } from "@config/sources";
import { getDb, getSetting, setSetting, type Db } from "@/lib/db";
import { env } from "@/lib/env";
import { fetchArticle } from "@/lib/article";
import { fetchFeed } from "@/lib/feeds";
import { assertModelsAvailable, pool, realLlm } from "@/lib/llm";
import { oneLine, splitSentences, wordCount } from "@/lib/text";
import { checkDraft, copyDesk } from "./copyEditor";
import { deskSorter } from "./deskSorter";
import { factCheck, precheck } from "./factChecker";
import { qualifies, toOutletReport } from "./outlets";
import { pressDecision, readPressRules } from "./pressRoom";
import { reviseDraft, writeDraft } from "./rewriteDesk";
import { runStep, setEventStatus, writeStep } from "./runlog";
import type { Ctx, EventRow, Fact } from "./types";
import { wireScout } from "./wireScout";

const MAX_STEP_FAILURES = 3;
const LOCK_STALE_MS = 45 * 60_000;

export interface SweepSummary {
  sweepId: number;
  newReports: number;
  eventsOpened: number;
  waiting: number;
  expired: number;
  taken: number;
  deferred: number;
  printed: number;
  held: number;
  spiked: number;
  backToWaiting: number;
  failed: number;
  promptTokens: number;
  completionTokens: number;
  llmCalls: number;
  costUsd: number;
  seconds: number;
}

/** Take one qualified event from fact check to the press. */
export async function processEvent(ctx: Ctx, ev: EventRow): Promise<"printed" | "held" | "spiked" | "waiting" | "failed"> {
  const { db } = ctx;
  setEventStatus(ctx, ev.id, "working", null, "On the desks");
  try {
    /* 3. Fact Checker */
    const checked = await runStep(ctx, "Fact Checker", ev.id, async (meter) => {
      const out = await factCheck(ctx, ev, meter);
      return { note: out.kind === "ready" || out.kind === "waiting" || out.kind === "expired" ? out.note : "No change", value: out };
    });
    if (checked.kind !== "ready") {
      setEventStatus(ctx, ev.id, "waiting", null, checked.kind === "waiting" ? checked.note : "Waiting");
      return "waiting";
    }
    const facts: Fact[] = checked.facts;
    const desk = ev.desk as Desk;

    /* 4. Rewrite Desk */
    const first = await runStep(ctx, "Rewrite Desk", ev.id, async (meter) => {
      const d = await writeDraft(ctx.llm, meter, desk, facts);
      return { note: `Wrote "${d.headline}" (${d.headline.length} chars) and a ${wordCount(d.body)}-word body from ${facts.length} facts`, value: d };
    });

    /* 5. Copy Editor (one rewrite allowed) */
    const edited = await copyDesk(first, {
      check: (draft, pass) =>
        runStep(ctx, "Copy Editor", ev.id, async (meter) => {
          const problems = await checkDraft(ctx.llm, meter, facts, draft);
          const n = splitSentences(draft.body).length + 1;
          const note = !problems.length
            ? `${pass === 2 ? "After the rewrite, all" : "All"} ${n} sentences are supported by the fact sheet`
            : `${problems.length} of ${n} sentences unsupported (${oneLine(problems[0].problem, 110)}); ` +
              (pass === 1 ? "sent back for one rewrite" : "still unsupported after the rewrite, story spiked");
          return { note, value: problems };
        }),
      rewrite: (draft, problems) =>
        runStep(ctx, "Rewrite Desk", ev.id, async (meter) => {
          const d = await reviseDraft(ctx.llm, meter, desk, facts, draft, problems);
          return { note: `Rewrote the copy to fix ${problems.length} unsupported sentence${problems.length > 1 ? "s" : ""}: "${d.headline}"`, value: d };
        }),
    });
    if (edited.outcome === "spiked") {
      setEventStatus(ctx, ev.id, "spiked", "unsupported_copy",
        `Spiked by the Copy Editor: "${oneLine(edited.problems[0].sentence, 90)}" is not supported by the fact sheet`);
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
      const behind = db
        .prepare(
          `SELECT DISTINCT r.id, r.outlet_id, r.wire_agency, r.fingerprint
           FROM fact_claims c JOIN fact_claim_support s ON s.fact_claim_id = c.id JOIN reports r ON r.id = s.report_id
           WHERE c.event_id = ? AND c.status = 'corroborated'`,
        )
        .all(ev.id) as unknown as Parameters<typeof toOutletReport>[0][];
      const q = qualifies(behind.map(toOutletReport), env.minOutlets);
      if (!q.ok) throw new Error(`refused to print: ${q.reason}`);

      const rules = readPressRules(db, desk);
      const decision = pressDecision(rules.pressesStopped, rules.rule);
      if (decision.action === "print") {
        setEventStatus(ctx, ev.id, "printed", null, `Printed with ${q.count} outlets behind it`, {
          printed_at: ctx.now().toISOString(), outlet_count: q.count,
        });
        return { note: `${decision.note}; ${q.count} independent outlets behind the fact sheet`, value: "printed" as const };
      }
      setEventStatus(ctx, ev.id, "held", decision.reason, decision.note, { outlet_count: q.count });
      return { note: decision.note, value: "held" as const };
    });
  } catch (e) {
    const fails = ev.fail_count + 1;
    const msg = oneLine((e as Error)?.message ?? String(e), 160);
    if (fails >= MAX_STEP_FAILURES) {
      setEventStatus(ctx, ev.id, "spiked", "step_failed", `Spiked after ${fails} failed attempts: ${msg}`, { fail_count: fails });
    } else {
      setEventStatus(ctx, ev.id, "waiting", "step_failed", `A step failed (${msg}); will retry next sweep`, { fail_count: fails, facts_stale: 1 });
    }
    ctx.log(`  event ${ev.id}: step failed (${msg})`);
    return "failed";
  }
}

function acquireLock(db: Db, now: Date): boolean {
  const cur = getSetting(db, "sweep_lock");
  if (cur && now.getTime() - new Date(cur).getTime() < LOCK_STALE_MS) return false;
  setSetting(db, "sweep_lock", now.toISOString());
  return true;
}

/** One full pass of the pipeline. */
export async function sweep(overrides: Partial<Ctx> & { skipModelCheck?: boolean } = {}): Promise<SweepSummary | null> {
  const db = overrides.db ?? getDb();
  const now = overrides.now ?? (() => new Date());
  const log = overrides.log ?? ((l: string) => console.log(l));
  if (!acquireLock(db, now())) {
    log("Another sweep is still running; skipping this one.");
    return null;
  }
  const t0 = Date.now();
  const sweepId = Number(db.prepare("INSERT INTO sweeps (started_at) VALUES (?)").run(now().toISOString()).lastInsertRowid);
  try {
    if (!overrides.llm && !overrides.skipModelCheck) await assertModelsAvailable();
    const ctx: Ctx = {
      db, now, log, sweepId,
      llm: overrides.llm ?? realLlm(),
      fetchFeed: overrides.fetchFeed ?? ((url) => fetchFeed(db, url)),
      fetchArticle: overrides.fetchArticle ?? fetchArticle,
    };

    // A crash can leave stories on the desks; put them back in the queue.
    db.prepare("UPDATE events SET status = 'waiting', facts_stale = 1, status_note = 'Returned to the queue after an interrupted sweep' WHERE status = 'working'").run();

    log(`Sweep ${sweepId}: Wire Scout reading feeds...`);
    const scout = await wireScout(ctx).catch((e) => (log(`  Wire Scout failed: ${e.message}`), { stored: 0 }));
    log(`  ${scout.stored} new reports. Desk Sorter grouping...`);
    const sorted = await deskSorter(ctx).catch((e) => (log(`  Desk Sorter failed: ${e.message}`), { opened: 0, joined: 0, discarded: 0 }));
    log(`  ${sorted.opened} events opened, ${sorted.joined} reports joined existing events, ${sorted.discarded} discarded.`);

    /* Recheck everything that is waiting. */
    const waitingEvents = db
      .prepare(
        `SELECT e.*, (SELECT COUNT(DISTINCT outlet_id) FROM reports r WHERE r.event_id = e.id) AS outlets
         FROM events e WHERE e.status = 'waiting' ORDER BY outlets DESC, e.created_at ASC`,
      )
      .all() as unknown as EventRow[];
    const queue: EventRow[] = [];
    let waiting = 0, expired = 0, deferred = 0;
    const bump = db.prepare("UPDATE events SET recheck_count = recheck_count + 1, last_checked_at = ? WHERE id = ?");
    for (const ev of waitingEvents) {
      const iso = now().toISOString();
      const pre = precheck(ctx, ev);
      bump.run(iso, ev.id);
      if (pre.kind === "expired") {
        setEventStatus(ctx, ev.id, "spiked", "expired_unconfirmed", pre.note);
        writeStep(db, { sweepId, eventId: ev.id, agent: "Fact Checker", status: "ok", startedAt: iso, endedAt: iso, note: pre.note });
        expired++;
      } else if (pre.kind === "waiting") {
        waiting++;
        // One step when the picture changes, not one per sweep: the recheck
        // itself is recorded on the event (recheck_count, last_checked_at).
        if (pre.changed) {
          setEventStatus(ctx, ev.id, "waiting", null, pre.note);
          writeStep(db, { sweepId, eventId: ev.id, agent: "Fact Checker", status: "ok", startedAt: iso, endedAt: iso, note: pre.note });
        }
      } else if (pre.kind === "unchanged") {
        waiting++;
      } else if (pre.kind === "go") {
        if (queue.length < env.maxEventsPerSweep) queue.push(ev);
        else deferred++;
      }
    }
    log(`  ${waiting} events waiting, ${expired} expired, ${queue.length} qualified for the desks${deferred ? ` (${deferred} more deferred to the next sweep)` : ""}.`);

    const counts = { printed: 0, held: 0, spiked: 0, waiting: 0, failed: 0 };
    await pool(queue, 4, async (ev) => {
      const outcome = await processEvent(ctx, ev);
      counts[outcome]++;
      const row = db.prepare("SELECT headline, status_note FROM events WHERE id = ?").get(ev.id) as { headline: string | null; status_note: string };
      log(`  [${outcome}] #${ev.id} ${oneLine(row.headline ?? ev.label, 70)}${outcome === "printed" ? "" : ` — ${oneLine(row.status_note, 110)}`}`);
    });

    const usage = db
      .prepare("SELECT COALESCE(SUM(prompt_tokens),0) p, COALESCE(SUM(completion_tokens),0) c, COALESCE(SUM(llm_calls),0) n, COALESCE(SUM(cost_usd),0) usd FROM steps WHERE sweep_id = ?")
      .get(sweepId) as { p: number; c: number; n: number; usd: number };
    const summary: SweepSummary = {
      sweepId, newReports: scout.stored, eventsOpened: sorted.opened, waiting: waiting + counts.waiting, expired,
      taken: queue.length, deferred, printed: counts.printed, held: counts.held, spiked: counts.spiked,
      backToWaiting: counts.waiting, failed: counts.failed,
      promptTokens: usage.p, completionTokens: usage.c, llmCalls: usage.n, costUsd: Math.round(usage.usd * 1e4) / 1e4,
      seconds: Math.round((Date.now() - t0) / 1000),
    };
    db.prepare("UPDATE sweeps SET ended_at = ?, summary = ? WHERE id = ?").run(now().toISOString(), JSON.stringify(summary), sweepId);
    log(
      `Sweep ${sweepId} done in ${summary.seconds}s: ${summary.printed} printed, ${summary.held} held, ${summary.spiked} spiked, ` +
      `${summary.waiting} waiting. ${summary.llmCalls} model calls, ${summary.promptTokens} in / ${summary.completionTokens} out tokens, about $${summary.costUsd.toFixed(4)}.`,
    );
    return summary;
  } finally {
    db.prepare("DELETE FROM settings WHERE key = 'sweep_lock'").run();
  }
}
