import { DESKS, DESK_LABELS, fetchModeOf, outletName, type Desk } from "../../config/sources";
import { istDayStart, nextIstMidnight, spentToday } from "./budget";
import { getSetting, type Db } from "./db";
import { env } from "./env";
import { isLiveBlog } from "../pipeline/liveblog";
import { AGENTS, type Agent } from "../pipeline/types";

/** Read-only queries behind the newsroom console. */

const all = <T>(db: Db, sql: string, ...args: (string | number)[]) => db.prepare(sql).all(...args) as unknown as T[];
const one = <T>(db: Db, sql: string, ...args: (string | number)[]) => db.prepare(sql).get(...args) as unknown as T | undefined;

export interface Health {
  workerAlive: boolean;
  workerState: string;
  heartbeatAt: string | null;
  nextSweepAt: string | null;
  lastSweep: null | { id: number; startedAt: string; endedAt: string | null; seconds: number | null; failed: number; error: string | null; printed: number; taken: number; running: boolean };
  spendToday: number;
  cap: number;
  budgetPaused: boolean;
  resumesAt: string;
  sweepRequested: boolean;
}

export interface Overview {
  now: string;
  sweepMinutes: number;
  pressesStopped: boolean;
  stats: { onDesk: number; waiting: number; printedToday: number; spikedToday: number; retractedToday: number };
  desks: { desk: Desk; label: string; rule: string }[];
  health: Health;
  submissions: SubmissionView[];
}

export interface SubmissionView {
  id: number;
  input: string;
  kind: string;
  desk: string;
  createdAt: string;
  /** queued | working | waiting_second_outlet | on_desk | printed | held | spiked | retracted | no_match | rejected | failed */
  state: string;
  line: string;
  eventId: number | null;
}

const WORKER_STALE_MS = 15_000;

function submissionView(db: Db, s: { id: number; input: string; kind: string; desk: string; created_at: string; status: string; outcome: string | null; note: string | null; event_id: number | null }): SubmissionView {
  const base = { id: s.id, input: s.input, kind: s.kind, desk: s.desk, createdAt: s.created_at, eventId: s.event_id };
  if (s.status === "queued") return { ...base, state: "queued", line: "Queued. The worker picks it up within a few seconds." };
  if (s.status === "working") return { ...base, state: "working", line: "Being matched against stored reports." };
  if (s.outcome !== "matched" || !s.event_id) {
    const state = s.outcome ?? "failed";
    const lead = state === "no_match" ? "Matched nothing. " : state === "rejected" ? "Not accepted. " : "Failed. ";
    return { ...base, state, line: lead + (s.note ?? "").replace(/^Matched nothing: /, "") };
  }
  const ev = one<{ status: string; status_note: string | null; outlet_count: number; headline: string | null; label: string }>(
    db, "SELECT status, status_note, outlet_count, headline, label FROM events WHERE id = ?", s.event_id,
  )!;
  const title = ev.headline ?? ev.label;
  if (ev.status === "waiting") {
    const single = /independent (outlet|source)/.test(ev.status_note ?? "") || /only corroboration/.test(ev.status_note ?? "");
    if (/only corroboration/.test(ev.status_note ?? "")) {
      return { ...base, state: "waiting_second_outlet", line: "Waiting for a content outlet. So far only corroboration-only outlets have reported it; it prints once Times of India, Hindustan Times or Indian Express does too." };
    }
    return single
      ? { ...base, state: "waiting_second_outlet", line: `Waiting for a second outlet. ${(ev.status_note ?? "").replace(/^Waiting: /, "")}. It prints only when a second independent outlet reports it.` }
      : { ...base, state: "waiting", line: ev.status_note ?? "Waiting." };
  }
  const lines: Record<string, string> = {
    working: `On the desks now: ${title}`,
    printed: `Printed: ${title}`,
    held: `Held for your sign-off: ${title}`,
    spiked: `Spiked. ${ev.status_note ?? ""}`,
    retracted: `Retracted. ${ev.status_note ?? ""}`,
  };
  return { ...base, state: ev.status === "working" ? "on_desk" : ev.status, line: lines[ev.status] ?? ev.status };
}

export function overview(db: Db, now = new Date()): Overview {
  const day = istDayStart(now).toISOString();
  const count = (sql: string, ...a: (string | number)[]) => one<{ n: number }>(db, sql, ...a)!.n;
  const hbRaw = getSetting(db, "worker_heartbeat");
  let hb: { at?: string; state?: string; nextSweepAt?: string } = {};
  try {
    hb = hbRaw ? JSON.parse(hbRaw) : {};
  } catch {
    hb = {};
  }
  const alive = !!hb.at && hb.state !== "stopped" && now.getTime() - new Date(hb.at).getTime() < WORKER_STALE_MS;
  const last = one<{ id: number; started_at: string; ended_at: string | null; summary: string | null }>(db, "SELECT * FROM sweeps ORDER BY id DESC LIMIT 1");
  let lastSweep: Health["lastSweep"] = null;
  if (last) {
    let s: { seconds?: number; failed?: number; error?: string; printed?: number; taken?: number } = {};
    try {
      s = last.summary ? JSON.parse(last.summary) : {};
    } catch {
      s = {};
    }
    lastSweep = {
      id: last.id, startedAt: last.started_at, endedAt: last.ended_at, seconds: s.seconds ?? null, failed: s.failed ?? 0,
      error: s.error ?? (last.ended_at || (alive && hb.state === "sweeping") ? null : "did not finish"),
      printed: s.printed ?? 0, taken: s.taken ?? 0, running: !last.ended_at && alive && hb.state === "sweeping",
    };
  }
  const spend = spentToday(db, now);
  const subs = all<Parameters<typeof submissionView>[1]>(db, "SELECT * FROM submissions ORDER BY id DESC LIMIT 8");
  return {
    now: now.toISOString(),
    sweepMinutes: env.sweepMinutes,
    pressesStopped: getSetting(db, "presses_stopped") === "1",
    stats: {
      onDesk: count("SELECT COUNT(*) n FROM events WHERE status IN ('working','held')"),
      waiting: count("SELECT COUNT(*) n FROM events WHERE status = 'waiting'"),
      printedToday: count("SELECT COUNT(*) n FROM events WHERE status = 'printed' AND printed_at >= ?", day),
      spikedToday: count("SELECT COUNT(*) n FROM events WHERE status = 'spiked' AND updated_at >= ?", day),
      retractedToday: count("SELECT COUNT(*) n FROM events WHERE status = 'retracted' AND updated_at >= ?", day),
    },
    desks: DESKS.map((desk) => ({
      desk, label: DESK_LABELS[desk],
      rule: one<{ rule: string }>(db, "SELECT rule FROM desk_rules WHERE desk = ?", desk)?.rule ?? "review",
    })),
    health: {
      workerAlive: alive, workerState: alive ? (hb.state ?? "idle") : "not running", heartbeatAt: hb.at ?? null,
      nextSweepAt: alive ? (hb.nextSweepAt ?? null) : null, lastSweep,
      spendToday: Math.round(spend * 1e4) / 1e4, cap: env.dailyBudgetUsd, budgetPaused: spend >= env.dailyBudgetUsd,
      resumesAt: nextIstMidnight(now).toISOString(),
      sweepRequested: !!one(db, "SELECT 1 x FROM worker_commands WHERE kind = 'sweep_now' AND picked_at IS NULL"),
    },
    submissions: subs.map((s) => submissionView(db, s)),
  };
}

/* ---------------------------------------------------------------- the table */

export interface StoryRow {
  id: number;
  title: string;
  desk: string;
  deskLabel: string;
  status: string;
  /** 0..6 = the agent it is at; 7 = through the press. */
  stage: number;
  agent: string;
  state: string;
  outlets: string;
  createdAt: string;
  recheckCount: number;
  lastCheckedAt: string | null;
  fromEditor: boolean;
}

export const FILTERS = ["desk", "waiting", "held", "printed", "spiked", "retracted", "all"] as const;
export type Filter = (typeof FILTERS)[number];
const FILTER_SQL: Record<Filter, string> = {
  desk: "e.status IN ('working','held')",
  waiting: "e.status = 'waiting'",
  held: "e.status = 'held'",
  printed: "e.status = 'printed'",
  spiked: "e.status = 'spiked'",
  retracted: "e.status = 'retracted'",
  all: "1 = 1",
};
export const PAGE_SIZE = 25;

interface EvRow {
  id: number; label: string; headline: string | null; desk: string; status: string; status_reason: string | null; status_note: string | null;
  outlet_count: number; current_agent: string | null; created_at: string; recheck_count: number; last_checked_at: string | null; priority: number;
  outlets: number; last_agent: string | null; has_article: number;
}

function stageOf(e: EvRow): { stage: number; agent: string; state: string } {
  const idx = (a: string | null) => Math.max(0, AGENTS.indexOf((a ?? "Fact Checker") as Agent));
  switch (e.status) {
    case "working": {
      const stage = e.current_agent ? idx(e.current_agent) : Math.min(6, idx(e.last_agent) + 1);
      return { stage, agent: AGENTS[stage], state: "Working" };
    }
    case "waiting": {
      const second = /independent (outlet|source)|only corroboration/.test(e.status_note ?? "");
      const state = e.status_reason === "budget" ? "Paused: daily budget reached"
        : e.status_reason === "step_failed" ? "A step failed; will retry"
        : second ? "Waiting for a second source"
        : /New event|Returned|Released/.test(e.status_note ?? "") ? "Queued for the Fact Checker"
        : "Waiting: outlets do not yet agree on enough";
      return { stage: 2, agent: "Fact Checker", state };
    }
    case "held":
      return e.has_article
        ? { stage: 6, agent: "Press Room", state: "Held for your sign-off" }
        : { stage: 2, agent: "Fact Checker", state: "Held by an editor" };
    case "printed":
      return { stage: 7, agent: "None", state: "In the feed" };
    case "spiked":
      return { stage: idx(e.last_agent), agent: "None", state: e.status_reason?.startsWith("expired") ? "Expired" : e.status_reason === "editor_spike" ? "Dropped by an editor" : "Spiked" };
    default:
      return { stage: 7, agent: "None", state: "Removed from the feed" };
  }
}

const EV_SELECT = `
  SELECT e.id, e.label, e.headline, e.desk, e.status, e.status_reason, e.status_note, e.outlet_count, e.current_agent, e.created_at,
         e.recheck_count, e.last_checked_at, e.priority,
         (SELECT COUNT(DISTINCT r.outlet_id) FROM reports r WHERE r.event_id = e.id) AS outlets,
         (SELECT s.agent FROM steps s WHERE s.event_id = e.id ORDER BY s.id DESC LIMIT 1) AS last_agent,
         EXISTS (SELECT 1 FROM angles a WHERE a.event_id = e.id) AS has_article
  FROM events e`;

function toRow(e: EvRow): StoryRow {
  const st = stageOf(e);
  const confirmed = ["printed", "held", "retracted"].includes(e.status) || (e.status === "working" && e.outlet_count >= env.minOutlets);
  const n = confirmed ? Math.max(e.outlet_count, env.minOutlets) : e.outlets;
  return {
    id: e.id, title: e.headline ?? e.label, desk: e.desk, deskLabel: DESK_LABELS[e.desk as Desk] ?? e.desk, status: e.status,
    ...st,
    outlets: !confirmed && e.outlets < env.minOutlets ? `${e.outlets} of ${env.minOutlets}` : `${n} outlet${n === 1 ? "" : "s"}`,
    createdAt: e.created_at, recheckCount: e.recheck_count, lastCheckedAt: e.last_checked_at, fromEditor: e.priority > 0,
  };
}

export function listStories(db: Db, opts: { filter?: string; desk?: string; q?: string; page?: number }) {
  const filter: Filter = (FILTERS as readonly string[]).includes(opts.filter ?? "") ? (opts.filter as Filter) : "desk";
  const where = [FILTER_SQL[filter]];
  const args: (string | number)[] = [];
  if (opts.desk && (DESKS as readonly string[]).includes(opts.desk)) {
    where.push("e.desk = ?");
    args.push(opts.desk);
  }
  const q = (opts.q ?? "").trim().slice(0, 80);
  if (q) {
    where.push("(e.label LIKE ? ESCAPE '\\' OR e.headline LIKE ? ESCAPE '\\')");
    const like = `%${q.replace(/[\\%_]/g, "\\$&")}%`;
    args.push(like, like);
  }
  const total = one<{ n: number }>(db, `SELECT COUNT(*) n FROM events e WHERE ${where.join(" AND ")}`, ...args)!.n;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const page = Math.min(pages, Math.max(1, Math.floor(opts.page ?? 1) || 1));
  const rows = all<EvRow>(
    db,
    `${EV_SELECT} WHERE ${where.join(" AND ")}
     ORDER BY (e.status = 'working') DESC, (e.status = 'held') DESC, e.priority DESC, e.updated_at DESC, e.id DESC LIMIT ? OFFSET ?`,
    ...args, PAGE_SIZE, (page - 1) * PAGE_SIZE,
  );
  return { filter, page, pages, total, pageSize: PAGE_SIZE, rows: rows.map(toRow) };
}

/* -------------------------------------------------------------- run sheet */

export interface StepView {
  agent: string;
  /** done | now | wait | failed | skipped | idle */
  mark: string;
  status: string;
  note: string;
  startedAt: string | null;
  seconds: number | null;
  model: string | null;
  promptTokens: number;
  completionTokens: number;
  calls: number;
  costUsd: number;
  runs: number;
}

const JOBS: Record<Agent, string> = {
  "Wire Scout": "Reads the outlet feeds for new reports.",
  "Desk Sorter": "Groups matching reports and files them to a desk.",
  "Fact Checker": "Compares every claim across outlets.",
  "Rewrite Desk": "Writes the article from the fact sheet.",
  "Copy Editor": "Traces every sentence back to the fact sheet.",
  "Picture Desk": "Finds a licensed photo or makes a labelled illustration.",
  "Press Room": "Prints the story to the feed with its source links.",
};

export function runSheet(db: Db, id: number) {
  const e = one<EvRow & { printed_at: string | null; expires_at: string; updated_at: string }>(db, `${EV_SELECT.replace("e.priority,", "e.priority, e.printed_at, e.expires_at, e.updated_at,")} WHERE e.id = ?`, id);
  if (!e) return null;
  const row = toRow(e);

  const reports = all<{ id: number; outlet_id: string; url: string; title: string; published_at: string; wire_agency: string | null; text_source: string | null; byline: string | null }>(
    db, "SELECT id, outlet_id, url, title, published_at, wire_agency, text_source, byline FROM reports WHERE event_id = ? ORDER BY published_at", id,
  ).map((r) => ({
    id: r.id, outlet: outletName(r.outlet_id), url: r.url, title: r.title, publishedAt: r.published_at, wire: r.wire_agency,
    live: isLiveBlog(r.url, r.title),
    read: r.text_source === "article" ? "full article" : r.text_source === "feed_summary" ? "headline and summary" : fetchModeOf(r.outlet_id) === "feed" ? "not read yet (feed only)" : "not read yet",
  }));

  const steps = all<{ id: number; sweep_id: number | null; agent: Agent; status: string; started_at: string; ended_at: string; note: string; model: string | null; prompt_tokens: number; completion_tokens: number; llm_calls: number; cost_usd: number }>(
    db, "SELECT * FROM steps WHERE event_id = ? ORDER BY id", id,
  );
  // The Wire Scout works a whole sweep at a time; show the scout step of the sweep that first brought this story in.
  const firstSweep = steps.find((s) => s.sweep_id !== null)?.sweep_id;
  const scout = firstSweep ? one<(typeof steps)[number]>(db, "SELECT * FROM steps WHERE sweep_id = ? AND agent = 'Wire Scout' ORDER BY id LIMIT 1", firstSweep) : undefined;
  const outletsSeen = [...new Set(reports.map((r) => r.outlet))];

  const secs = (s: { started_at: string; ended_at: string }) => Math.max(0, Math.round((Date.parse(s.ended_at) - Date.parse(s.started_at)) / 100) / 10);
  const view: StepView[] = AGENTS.map((agent, i) => {
    const mine = agent === "Wire Scout" ? (scout ? [scout] : []) : steps.filter((s) => s.agent === agent);
    const last = mine[mine.length - 1];
    const sum = (k: "prompt_tokens" | "completion_tokens" | "llm_calls" | "cost_usd") => mine.reduce((n, s) => n + s[k], 0);
    const isNow = e.status === "working" && row.stage === i;
    const isWait = (e.status === "waiting" || e.status === "held") && row.stage === i;
    let mark = "idle";
    let status = ["waiting", "working", "held"].includes(e.status) ? "Queued" : "Not run";
    let note = JOBS[agent];
    if (last) {
      mark = last.status === "failed" ? "failed" : last.status === "skipped" ? "skipped" : "done";
      status = last.status === "failed" ? "Failed" : last.status === "skipped" ? "Skipped" : "Done";
      note = agent === "Wire Scout" ? `Picked up ${reports.length} report${reports.length === 1 ? "" : "s"} from ${outletsSeen.join(", ") || "the feeds"}.` : last.note;
    }
    if (isNow) {
      mark = "now";
      status = "Working";
      if (!last || e.current_agent === agent) note = JOBS[agent];
    } else if (isWait) {
      mark = "wait";
      status = e.status === "held" ? "Held" : "Waiting";
      note = e.status_note ?? note;
    }
    return {
      agent, mark, status, note,
      startedAt: last?.started_at ?? null, seconds: last && agent !== "Wire Scout" ? secs(last) : null, model: last?.model ?? null,
      promptTokens: agent === "Wire Scout" ? 0 : sum("prompt_tokens"), completionTokens: agent === "Wire Scout" ? 0 : sum("completion_tokens"),
      calls: agent === "Wire Scout" ? 0 : sum("llm_calls"), costUsd: agent === "Wire Scout" ? 0 : Math.round(sum("cost_usd") * 1e4) / 1e4, runs: mine.length,
    };
  });

  const claimOutlets = db.prepare(
    "SELECT DISTINCT r.outlet_id FROM fact_claim_support s JOIN reports r ON r.id = s.report_id WHERE s.fact_claim_id = ?",
  );
  const claims = all<{ id: number; text: string; status: string; role: string }>(
    db, "SELECT id, text, status, role FROM fact_claims WHERE event_id = ? ORDER BY CASE role WHEN 'core' THEN 0 WHEN 'supporting' THEN 1 ELSE 2 END, id", id,
  ).map((c) => ({ ...c, outlets: (claimOutlets.all(c.id) as { outlet_id: string }[]).map((o) => outletName(o.outlet_id)) }));
  const angle = one<{ body: string; word_count: number }>(db, "SELECT body, word_count FROM angles WHERE event_id = ? AND angle_key = 'general'", id);

  const statusLines: Record<string, string> = {
    working: "Moving through the desk now.",
    waiting: row.state === "Waiting for a second source"
      ? "Seen in one independent outlet. It prints only when a second outlet reports the same event."
      : e.status_note ?? "Waiting.",
    held: e.has_article ? "Held. Nothing reaches the feed until you approve it." : "Held by an editor before it was written. Release it to send it back through the checks.",
    printed: "Printed. Readers can see it in the feed.",
    spiked: e.status_note ?? "Spiked. This story will not be printed.",
    retracted: e.status_note ?? "Retracted. It has been removed from the feed.",
  };

  return {
    ...row,
    statusNote: e.status_note,
    statusLine: statusLines[e.status] ?? e.status,
    label: e.label,
    printedAt: e.printed_at,
    expiresAt: e.expires_at,
    updatedAt: e.updated_at,
    steps: view,
    history: steps.map((s) => ({ id: s.id, agent: s.agent, status: s.status, note: s.note, startedAt: s.started_at, seconds: secs(s), model: s.model, tokens: s.prompt_tokens + s.completion_tokens, costUsd: s.cost_usd })),
    facts: claims.filter((c) => c.status === "corroborated"),
    conflicts: claims.filter((c) => c.status === "conflicting"),
    article: e.headline && angle ? { headline: e.headline, body: angle.body, words: angle.word_count, printed: e.status === "printed" } : null,
    reports,
    actions: all<{ at: string; actor: string; action: string; detail: string | null }>(db, "SELECT at, actor, action, detail FROM admin_actions WHERE event_id = ? ORDER BY id", id),
    can: {
      approve: e.status === "held",
      approveLabel: e.has_article ? "Approve and print" : "Release hold",
      hold: e.status === "working" || e.status === "waiting",
      retract: e.status === "printed",
      spike: ["working", "waiting", "held"].includes(e.status),
    },
  };
}

export type RunSheet = NonNullable<ReturnType<typeof runSheet>>;
