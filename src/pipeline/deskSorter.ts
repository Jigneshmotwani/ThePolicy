import { z } from "zod";
import { DESKS, DESK_LABELS, outletName, type Desk } from "@config/sources";
import { BudgetExceededError } from "@/lib/budget";
import { env, EVENT_WINDOW_HOURS } from "@/lib/env";
import { Meter, pool } from "@/lib/llm";
import { cosine, tfidfVectors } from "@/lib/text";
import { isLiveBlog } from "./liveblog";
import { runStep, writeStep } from "./runlog";
import type { Ctx, ReportRow } from "./types";

/**
 * Desk Sorter: decide which desk each new report belongs to (or none), then
 * group reports about the same event from the last 48 hours.
 *
 * Grouping is two-step. A cheap shortlist (time window + TF-IDF similarity of
 * headline and summary) proposes pairs; the fast model then confirms whether
 * each pair really is the same event. Nothing is grouped on similarity alone.
 */

export const SHORTLIST_SIMILARITY = 0.22;
const MAX_CANDIDATES = 3;
const CLASSIFY_BATCH = 20;

const classifySchema = z.object({
  items: z.array(
    z.object({
      i: z.number().int(),
      desk: z.enum([...DESKS, "none"]),
      kind: z.enum(["event", "other"]),
    }),
  ),
});

const CLASSIFY_SYSTEM = `You sort incoming news reports for an Indian news agency.
For each report decide:
- "kind": "event" if it reports a specific, recent real-world happening (an incident, announcement, decision, result, death, launch, court ruling, match, release). "other" for everything else: opinion, editorial, analysis, explainer, listicle, how-to, advice, horoscope, quiz, photo gallery, review, live blog, rolling "live updates" page, puzzle answers, deals, celebrity gossip without a concrete happening, evergreen features.
- "desk": the single best desk, one of: india (national and state news, politics, courts, crime, weather, society), world (events outside India), business (economy, markets, companies, technology business), sport, entertainment (film, TV, music, celebrity events). Use "none" if no desk fits (lifestyle, health tips, astrology, travel, food, education listings, city trivia).
The feed section is a hint and is sometimes wrong.
Return {"items":[{"i":<number>,"desk":"...","kind":"..."}]} with exactly one entry per report.`;

const matchSchema = z.object({ same_event: z.boolean() });

const MATCH_SYSTEM = `You decide whether two news reports describe the SAME EVENT.
Same event means the same specific real-world happening: the same incident, announcement, decision, match, death or release, at the same time and place. Two outlets covering it from different angles are still the same event.
NOT the same event: different incidents on the same topic, a different match in the same tournament, a later separate development, a reaction piece about something else, a follow-up about what one of the people involved does next, or reports that merely involve the same person, film or company.
If you cannot tell, answer false.
Return {"same_event": true} or {"same_event": false}.`;

export interface Sorted {
  report: ReportRow;
  desk: Desk;
}

export interface GroupResult {
  opened: number;
  joined: number;
  pairs: number;
  confirmed: number;
  /** True when the daily budget ran out mid-way: nothing was grouped, the reports stay "new". */
  aborted: boolean;
  /** report id -> the event it now belongs to */
  eventOf: Map<number, number>;
}

/**
 * Group already-classified reports into events (joining live events from the
 * window, or opening new ones) and write a Desk Sorter step for each event
 * touched. Used by the sweep and by "send a story to the desk".
 */
export async function groupReports(ctx: Ctx, meter: Meter, keptIn: Sorted[]): Promise<GroupResult> {
  const db = ctx.db;
  const nowMs = ctx.now().getTime();
  const windowStart = new Date(nowMs - EVENT_WINDOW_HOURS * 3600_000).toISOString();
  const kept = [...keptIn].sort((a, b) => a.report.published_at.localeCompare(b.report.published_at));

  /* ---- shortlist: who might be the same event? ---- */
  // Pool = reports already sitting in live events within the window + the new ones.
  const grouped = (
    db
      .prepare(
        `SELECT r.* FROM reports r JOIN events e ON e.id = r.event_id
         WHERE r.published_at >= ? AND e.status IN ('waiting','working','held','printed')`,
      )
      .all(windowStart) as unknown as ReportRow[]
  ).filter((r) => !kept.some((k) => k.report.id === r.id));
  const all = [...grouped, ...kept.map((k) => k.report)];
  const vecs = tfidfVectors(all);
  const newStart = grouped.length;

  interface Pair { a: number; b: number; sim: number } // indices into `all`; a is always new
  const pairs = new Map<string, Pair>();
  for (let a = newStart; a < all.length; a++) {
    const best = new Map<string, Pair>(); // one candidate per existing event / per new report
    for (let b = 0; b < all.length; b++) {
      if (b === a) continue;
      const sim = cosine(vecs[a], vecs[b]);
      if (sim < SHORTLIST_SIMILARITY) continue;
      const target = b < newStart ? `e${all[b].event_id}` : `r${all[b].id}`;
      const cur = best.get(target);
      if (!cur || sim > cur.sim) best.set(target, { a, b, sim });
    }
    for (const p of [...best.values()].sort((x, y) => y.sim - x.sim).slice(0, MAX_CANDIDATES)) {
      const key = p.b >= newStart ? [Math.min(p.a, p.b), Math.max(p.a, p.b)].join("-") : `${p.a}-${p.b}`;
      if (!pairs.has(key)) pairs.set(key, p);
    }
  }

  /* ---- the fast model confirms each shortlisted pair ---- */
  const pairList = [...pairs.values()];
  const pairMeters = pairList.map(() => new Meter());
  const describe = (r: ReportRow) =>
    `${outletName(r.outlet_id)}, ${r.published_at.slice(0, 16).replace("T", " ")} UTC\nHeadline: ${r.title}\nSummary: ${r.summary.slice(0, 300) || "(none)"}`;
  let aborted = false;
  const confirmed = await pool(pairList, 8, async (p, i) => {
    if (aborted) return false;
    try {
      const res = await ctx.llm.json({
        tier: "fast",
        system: MATCH_SYSTEM,
        user: `REPORT A\n${describe(all[p.a])}\n\nREPORT B\n${describe(all[p.b])}`,
        schema: matchSchema,
        meter: pairMeters[i],
        maxTokens: 1500,
      });
      return res.same_event;
    } catch (e) {
      if (e instanceof BudgetExceededError) aborted = true;
      return false; // could not confirm => not grouped
    }
  });
  if (aborted) {
    // Grouping on half the answers would split events. Leave these for a sweep that can afford it.
    for (const m of pairMeters) meter.absorb(m);
    return { opened: 0, joined: 0, pairs: pairList.length, confirmed: 0, aborted: true, eventOf: new Map() };
  }

  /* ---- resolve into events ---- */
  const parent = new Map<number, number>();
  const find = (i: number): number => {
    const p = parent.get(i) ?? i;
    if (p === i) return i;
    const root = find(p);
    parent.set(i, root);
    return root;
  };
  const joinEvent = new Map<number, { eventId: number; sim: number }>(); // new index -> best confirmed event
  pairList.forEach((p, i) => {
    if (!confirmed[i]) return;
    if (p.b >= newStart) parent.set(find(p.a), find(p.b));
    else {
      const cur = joinEvent.get(p.a);
      if (!cur || p.sim > cur.sim) joinEvent.set(p.a, { eventId: all[p.b].event_id!, sim: p.sim });
    }
  });
  const components = new Map<number, number[]>();
  for (let a = newStart; a < all.length; a++) {
    const root = find(a);
    components.set(root, [...(components.get(root) ?? []), a]);
  }

  const deskOf = new Map(kept.map((k) => [k.report.id, k.desk]));
  const iso = ctx.now().toISOString();
  const expires = new Date(nowMs + env.waitingTtlHours * 3600_000).toISOString();
  const attach = db.prepare("UPDATE reports SET sort_status = 'grouped', event_id = ? WHERE id = ?");
  let opened = 0, joined = 0;
  const eventMeter = new Map<number, Meter>();
  const eventNote = new Map<number, string>();
  const eventOf = new Map<number, number>();

  for (const members of components.values()) {
    const reports = members.map((i) => all[i]);
    let target: { eventId: number; sim: number } | undefined;
    for (const i of members) {
      const j = joinEvent.get(i);
      if (j && (!target || j.sim > target.sim)) target = j;
    }
    const names = [...new Set(reports.map((r) => outletName(r.outlet_id)))].join(", ");
    let eventId: number;
    db.exec("BEGIN");
    try {
      if (target) {
        eventId = target.eventId;
        db.prepare("UPDATE events SET facts_stale = 1, updated_at = ? WHERE id = ?").run(iso, eventId);
        joined += reports.length;
      } else {
        const desks = reports.map((r) => deskOf.get(r.id)!);
        const desk = DESKS.map((d) => [d, desks.filter((x) => x === d).length] as const).sort((x, y) => y[1] - x[1])[0][0];
        const r = db
          .prepare(
            `INSERT INTO events (label, desk, status, status_note, created_at, updated_at, expires_at)
             VALUES (?, ?, 'waiting', 'New event; not yet checked', ?, ?, ?)`,
          )
          .run(reports[0].title, desk, iso, iso, expires);
        eventId = Number(r.lastInsertRowid);
        opened++;
      }
      for (const r of reports) {
        attach.run(eventId, r.id);
        eventOf.set(r.id, eventId);
      }
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
    const total = db
      .prepare("SELECT COUNT(*) n, COUNT(DISTINCT outlet_id) o FROM reports WHERE event_id = ?")
      .get(eventId) as { n: number; o: number };
    const desk = (db.prepare("SELECT desk FROM events WHERE id = ?").get(eventId) as { desk: Desk }).desk;
    eventNote.set(
      eventId,
      target
        ? `Added ${reports.length} report${reports.length > 1 ? "s" : ""} (${names}); event now has ${total.n} reports from ${total.o} outlet${total.o > 1 ? "s" : ""}`
        : `Opened on the ${DESK_LABELS[desk]} desk with ${reports.length} report${reports.length > 1 ? "s" : ""} (${names})`,
    );
    eventMeter.set(eventId, eventMeter.get(eventId) ?? new Meter());
  }

  // Charge each confirmation call to the event it concerned; the rest go to the caller's meter.
  pairList.forEach((p, i) => {
    const ev = confirmed[i] ? eventOf.get(all[p.a].id) : undefined;
    const m = ev ? eventMeter.get(ev) : undefined;
    (m ?? meter).absorb(pairMeters[i]);
  });
  for (const [eventId, note] of eventNote) {
    writeStep(db, {
      sweepId: ctx.sweepId, eventId, agent: "Desk Sorter", status: "ok",
      startedAt: iso, endedAt: ctx.now().toISOString(), note, meter: eventMeter.get(eventId),
    });
  }
  return { opened, joined, pairs: pairList.length, confirmed: confirmed.filter(Boolean).length, aborted: false, eventOf };
}

export async function deskSorter(ctx: Ctx): Promise<{ opened: number; joined: number; discarded: number; budgetStopped: boolean }> {
  return runStep(ctx, "Desk Sorter", null, async (meter) => {
    const db = ctx.db;
    const nowMs = ctx.now().getTime();
    const windowStart = new Date(nowMs - EVENT_WINDOW_HOURS * 3600_000).toISOString();

    // Anything that aged out before we got to it is dropped, not grouped.
    const aged = db
      .prepare(
        `UPDATE reports SET sort_status = 'discarded', discard_note = 'older than the event window'
         WHERE sort_status = 'new' AND published_at < ?`,
      )
      .run(windowStart);

    const discard = db.prepare("UPDATE reports SET sort_status = 'discarded', discard_note = ? WHERE id = ?");
    let discarded = Number(aged.changes);
    let live = 0;
    const fresh: ReportRow[] = [];
    for (const r of db.prepare("SELECT * FROM reports WHERE sort_status = 'new' ORDER BY published_at ASC").all() as unknown as ReportRow[]) {
      // Live blogs and live-score pages keep changing: they cannot back a claim.
      if (isLiveBlog(r.url, r.title)) {
        discard.run("live blog or live-score page", r.id);
        discarded++;
        live++;
      } else fresh.push(r);
    }
    if (!fresh.length) {
      return {
        note: live ? `No new reports to sort (${live} live pages discarded)` : "No new reports to sort",
        status: "skipped",
        value: { opened: 0, joined: 0, discarded, budgetStopped: false },
      };
    }

    /* ---- 1. desk + is-it-an-event, in batches on the fast model ---- */
    const batches: ReportRow[][] = [];
    for (let i = 0; i < fresh.length; i += CLASSIFY_BATCH) batches.push(fresh.slice(i, i + CLASSIFY_BATCH));
    const kept: Sorted[] = [];
    let unsorted = 0;
    let budgetStopped = false;

    await pool(batches, 6, async (batch) => {
      const m = new Meter();
      try {
        if (budgetStopped) throw new Error("daily budget reached");
        const res = await ctx.llm.json({
          tier: "fast",
          system: CLASSIFY_SYSTEM,
          user: batch
            .map((r, i) => `${i}. [feed section: ${r.feed_desk}] ${r.title}${r.summary ? ` — ${r.summary.slice(0, 220)}` : ""}`)
            .join("\n"),
          schema: classifySchema,
          check: (v) => {
            const seen = new Set(v.items.map((x) => x.i));
            for (let i = 0; i < batch.length; i++) if (!seen.has(i)) return `missing entry for report ${i}`;
            return null;
          },
          meter: m,
          maxTokens: 3000,
        });
        for (let i = 0; i < batch.length; i++) {
          const verdict = res.items.find((x) => x.i === i)!;
          if (verdict.kind !== "event") {
            discard.run("not a report of a specific event", batch[i].id);
            discarded++;
          } else if (verdict.desk === "none") {
            discard.run("fits none of the five desks", batch[i].id);
            discarded++;
          } else {
            kept.push({ report: batch[i], desk: verdict.desk });
          }
        }
      } catch (e) {
        // Leave them 'new': they are retried next sweep rather than guessed at.
        unsorted += batch.length;
        if (e instanceof BudgetExceededError) budgetStopped = true;
        else if (!budgetStopped) ctx.log(`Desk Sorter: a batch of ${batch.length} could not be sorted (${(e as Error).message})`);
      } finally {
        meter.absorb(m);
      }
    });

    /* ---- 2-4. shortlist, confirm, resolve ---- */
    const g = await groupReports(ctx, meter, kept);
    if (g.aborted) {
      budgetStopped = true;
      unsorted += kept.length;
    }

    return {
      note:
        `Sorted ${fresh.length} new reports: ${g.opened} events opened, ${g.joined} reports joined existing events, ` +
        `${discarded} discarded${live ? ` (${live} live pages)` : ""}; model confirmed ${g.confirmed} of ${g.pairs} shortlisted pairs` +
        (unsorted ? `; ${unsorted} left for a later sweep${budgetStopped ? " (daily budget reached)" : " after a model failure"}` : ""),
      value: { opened: g.opened, joined: g.joined, discarded, budgetStopped },
    };
  });
}
