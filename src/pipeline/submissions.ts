import { z } from "zod";
import { fetchModeOf, outletByHost, outletName, type Desk } from "@config/sources";
import { BudgetExceededError } from "@/lib/budget";
import { getSetting } from "@/lib/db";
import { EVENT_WINDOW_HOURS } from "@/lib/env";
import { Meter } from "@/lib/llm";
import { cosine, oneLine, tfidfVectors } from "@/lib/text";
import { groupReports } from "./deskSorter";
import { precheck } from "./factChecker";
import { isLiveBlog } from "./liveblog";
import { writeStep } from "./runlog";
import { claimEvent, processEvent } from "./sweep";
import type { Ctx, EventRow, ReportRow } from "./types";

/**
 * "Send a story to the desk": an editor's link or topic.
 *
 * A submission only ever *points at* an event. From there the event goes
 * through exactly the same code as any other (precheck, Fact Checker,
 * Rewrite Desk, Copy Editor, Press Room), including the two-outlet rule.
 * What a submission buys is priority: it is handled at once and is never
 * deferred by MAX_EVENTS_PER_SWEEP.
 */

export interface SubmissionRow {
  id: number;
  input: string;
  kind: "link" | "topic";
  desk: string;
  status: string;
}

const TOPIC_SIMILARITY = 0.1;

const topicSchema = z.object({ match: z.number().int().nullable() });
const TOPIC_SYSTEM = `An editor has named a topic. You get a numbered list of news events we have reports on.
Pick the one event the editor most plausibly means: the same specific happening, not merely the same subject area.
If none of them is what the editor means, answer null. Do not stretch.
Return {"match": <number>} or {"match": null}.`;

function cleanUrl(raw: string): URL | null {
  try {
    const u = new URL(raw.trim());
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    u.hash = "";
    for (const k of [...u.searchParams.keys()]) if (k.toLowerCase().startsWith("utm_")) u.searchParams.delete(k);
    return u;
  } catch {
    return null;
  }
}

type Finish = { outcome: "matched" | "no_match" | "rejected" | "failed"; note: string; eventId?: number };

async function resolveLink(ctx: Ctx, sub: SubmissionRow, meter: Meter): Promise<Finish> {
  const u = cleanUrl(sub.input);
  if (!u) return { outcome: "rejected", note: "That is not a web link." };
  const outlet = outletByHost(u.hostname);
  if (!outlet) return { outcome: "rejected", note: `${u.hostname} is not one of the outlets we read, so its report cannot count as a source.` };
  const url = u.toString().replace(/\?$/, "");
  if (isLiveBlog(url)) return { outcome: "rejected", note: "That is a live blog or live-score page. Its text keeps changing, so it cannot back a claim." };

  const find = () =>
    ctx.db.prepare("SELECT * FROM reports WHERE url = ? OR url = ?").get(url, url.replace(/\/$/, "")) as unknown as ReportRow | undefined;
  let report = find();

  if (!report) {
    const iso = ctx.now().toISOString();
    if (fetchModeOf(outlet.id) === "feed") {
      // We read this outlet from its feeds only: refresh them and look again; the page itself is never requested.
      const insert = ctx.db.prepare(
        `INSERT OR IGNORE INTO reports (outlet_id, url, title, summary, feed_desk, published_at, fetched_at, byline) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const feed of outlet.feeds) {
        const res = await ctx.fetchFeed(feed.url).catch(() => null);
        for (const it of res?.items ?? []) insert.run(outlet.id, it.url, it.title, it.summary, feed.desk, it.publishedAt, iso, it.author ?? null);
      }
      report = find();
      if (!report) {
        return {
          outcome: "no_match",
          note: `That link is not in ${outlet.name}'s feeds right now, and we read ${outlet.name} from its feeds only (we do not fetch its pages).`,
        };
      }
    } else {
      const page = await ctx.fetchPage(url);
      if (!page) return { outcome: "failed", note: `Could not read that page on ${outlet.name}.` };
      ctx.db
        .prepare(
          `INSERT OR IGNORE INTO reports (outlet_id, url, title, summary, feed_desk, published_at, fetched_at, byline) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(outlet.id, url, page.headline.title, page.headline.summary, sub.desk, iso, iso, page.headline.author);
      report = find();
      if (!report) return { outcome: "failed", note: "Could not store that report." };
    }
  }

  if (isLiveBlog(report.url, report.title)) {
    return { outcome: "rejected", note: "That is a live blog or live-score page. Its text keeps changing, so it cannot back a claim." };
  }
  if (!report.event_id) {
    // Match it against stored reports exactly as the Desk Sorter would, on the desk the editor chose.
    if (report.sort_status === "discarded") ctx.db.prepare("UPDATE reports SET sort_status = 'new', discard_note = NULL WHERE id = ?").run(report.id);
    const g = await groupReports(ctx, meter, [{ report, desk: sub.desk as Desk }]);
    const eventId = g.eventOf.get(report.id);
    if (!eventId) return { outcome: "failed", note: "The report could not be matched (the daily budget may have been reached)." };
    return { outcome: "matched", eventId, note: `${outlet.name}: ${oneLine(report.title, 120)}` };
  }
  return { outcome: "matched", eventId: report.event_id, note: `${outlet.name}: ${oneLine(report.title, 120)}` };
}

async function resolveTopic(ctx: Ctx, sub: SubmissionRow, meter: Meter): Promise<Finish> {
  const since = new Date(ctx.now().getTime() - EVENT_WINDOW_HOURS * 3600_000).toISOString();
  const reports = ctx.db
    .prepare(
      `SELECT r.id, r.title, r.summary, r.event_id, e.label, e.status FROM reports r JOIN events e ON e.id = r.event_id
       WHERE r.published_at >= ? AND e.status IN ('waiting','working','held','printed')`,
    )
    .all(since) as unknown as { id: number; title: string; summary: string; event_id: number; label: string; status: string }[];
  if (!reports.length) return { outcome: "no_match", note: "No reports from the last 48 hours to match against." };

  const vecs = tfidfVectors([...reports, { title: sub.input, summary: "" }]);
  const topic = vecs[vecs.length - 1];
  const best = new Map<number, { sim: number; title: string }>();
  reports.forEach((r, i) => {
    const sim = cosine(topic, vecs[i]);
    const cur = best.get(r.event_id);
    if (sim >= TOPIC_SIMILARITY && (!cur || sim > cur.sim)) best.set(r.event_id, { sim, title: r.title });
  });
  const candidates = [...best.entries()].sort((a, b) => b[1].sim - a[1].sim).slice(0, 6);
  if (!candidates.length) return { outcome: "no_match", note: "Matched nothing: no report from the last 48 hours is about that." };

  const res = await ctx.llm.json({
    tier: "fast",
    system: TOPIC_SYSTEM,
    user: `EDITOR'S TOPIC: ${sub.input}\n\nEVENTS\n${candidates.map(([, c], i) => `${i}. ${c.title}`).join("\n")}`,
    schema: topicSchema,
    check: (v) => (v.match !== null && (v.match < 0 || v.match >= candidates.length) ? "match must be one of the listed numbers or null" : null),
    meter,
    maxTokens: 1500,
  });
  if (res.match === null) return { outcome: "no_match", note: "Matched nothing: none of the events we have reports on is that topic." };
  const [eventId, c] = candidates[res.match];
  return { outcome: "matched", eventId, note: `Matched to: ${oneLine(c.title, 120)}` };
}

/** Handle one queued submission from start to finish. Never throws. */
export async function processSubmission(ctx: Ctx, sub: SubmissionRow): Promise<void> {
  const db = ctx.db;
  const started = ctx.now().toISOString();
  db.prepare("UPDATE submissions SET status = 'working', picked_at = ? WHERE id = ?").run(started, sub.id);
  const meter = new Meter();
  let fin: Finish;
  try {
    fin = sub.kind === "link" ? await resolveLink(ctx, sub, meter) : await resolveTopic(ctx, sub, meter);
  } catch (e) {
    fin = {
      outcome: "failed",
      note: e instanceof BudgetExceededError ? "The daily budget is spent; try again after midnight IST." : `Could not be matched: ${oneLine((e as Error).message, 140)}`,
    };
  }
  const done = (f: Finish) =>
    db
      .prepare("UPDATE submissions SET status = 'done', outcome = ?, note = ?, event_id = ?, finished_at = ? WHERE id = ?")
      .run(f.outcome, oneLine(f.note, 300), f.eventId ?? null, ctx.now().toISOString(), sub.id);

  if (fin.outcome !== "matched" || !fin.eventId) {
    // The model calls spent on a submission that matched nothing still belong in the run log.
    if (meter.calls) {
      writeStep(db, { sweepId: null, eventId: null, agent: "Desk Sorter", status: "ok", startedAt: started, endedAt: ctx.now().toISOString(), note: `Editor submission "${oneLine(sub.input, 80)}": ${fin.note}`, meter });
    }
    done(fin);
    return;
  }

  const eventId = fin.eventId;
  if (meter.calls) {
    writeStep(db, { sweepId: null, eventId, agent: "Desk Sorter", status: "ok", startedAt: started, endedAt: ctx.now().toISOString(), note: `Matched an editor's ${sub.kind} to this event`, meter });
  }
  // Jump the queue: now, and in every later sweep while it waits.
  db.prepare("UPDATE events SET priority = 1 WHERE id = ?").run(eventId);
  // Record the match first, so the console can show the story while it is on the desks.
  done(fin);

  const ev = db.prepare("SELECT * FROM events WHERE id = ?").get(eventId) as unknown as EventRow;
  if (ev.status !== "waiting") return; // printed, held, on the desks or closed already: its status says so

  if (!ev.facts_stale) db.prepare("UPDATE events SET facts_stale = 1 WHERE id = ?").run(eventId); // an editor asked: check again
  const pre = precheck(ctx, { ...ev, facts_stale: 1 });
  const iso = ctx.now().toISOString();
  if (pre.kind === "waiting" || pre.kind === "expired") {
    // The two-outlet rule applies to editors too. It stays in the queue, at the front.
    if (pre.kind === "waiting") {
      db.prepare("UPDATE events SET status_note = ?, updated_at = ? WHERE id = ? AND status = 'waiting'").run(pre.note, iso, eventId);
      writeStep(db, { sweepId: null, eventId, agent: "Fact Checker", status: "ok", startedAt: iso, endedAt: iso, note: `Sent by an editor. ${pre.note}` });
    }
    return;
  }
  if (pre.kind !== "go") return;
  if (getSetting(db, "presses_stopped") === "1") return; // waits for the presses
  if (!claimEvent(ctx, eventId)) return;
  const outcome = await processEvent(ctx, { ...ev, facts_stale: 1 });
  ctx.log(`  [${outcome}] editor submission #${sub.id} -> event #${eventId}`);
}

/** Queued submissions, oldest first. */
export const queuedSubmissions = (ctx: Pick<Ctx, "db">) =>
  ctx.db.prepare("SELECT id, input, kind, desk, status FROM submissions WHERE status = 'queued' ORDER BY id").all() as unknown as SubmissionRow[];
