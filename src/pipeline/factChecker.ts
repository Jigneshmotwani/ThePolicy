import { z } from "zod";
import { fetchModeOf, outletName } from "@config/sources";
import { env } from "@/lib/env";
import { detectWireAgency } from "@/lib/article";
import type { Llm, Meter } from "@/lib/llm";
import { fingerprint } from "@/lib/text";
import { isLiveBlog } from "./liveblog";
import { independentGroups, qualifies, toOutletReport, type OutletReport } from "./outlets";
import type { Ctx, EventRow, Fact, FactRole, ReportRow } from "./types";

/**
 * Fact Checker: turn an event's reports into a fact sheet.
 *
 *   1. Read each report and list the claims it makes (our paraphrase). How
 *      much we read depends on the outlet's fetch mode: the article page
 *      ("full") or only the feed's headline and summary ("feed").
 *   2. Ask the strong model which claims from different reports say the same
 *      thing, which contradict each other, and what role each fact plays.
 *   3. In code, not on the model's say-so: keep a claim only if the reports
 *      behind it come from MIN_OUTLETS independent outlets, drop anything
 *      that is itself a dispute, and require at least one core claim.
 */

const MAX_REPORTS_READ = 6;

const claimsSchema = z.object({ claims: z.array(z.string().min(8).max(400)).max(16) });

const CLAIMS_SYSTEM = `You extract factual claims from one news report so they can be cross-checked against other outlets.
List up to 12 atomic claims the report states as fact about the event in its headline: who, what, where, when, how many, what was decided or said and by whom.
Rules:
- One fact per claim, a single plain sentence in YOUR OWN words. Never copy sentences from the report.
- Keep exact names, numbers, dates, places and titles as the report gives them.
- Attribute statements and allegations ("Police said...", "The company said...").
- Leave out opinion, speculation, background colour, the outlet's own analysis, and anything about other stories, adverts or page furniture.
- If you are given only a headline and a one-line summary, list only what those state. Do not expand on them.
- If the text is too thin to support any claim, return an empty list.
Return {"claims":["...", "..."]}.`;

const sheetSchema = z.object({
  conflicts: z.array(z.object({ note: z.string().max(400), claims: z.array(z.string()).min(2) })).default([]),
  facts: z.array(
    z.object({
      text: z.string().min(8).max(400),
      support: z.array(z.string()).min(1),
      role: z.enum(["core", "supporting", "background", "other_event"]),
    }),
  ),
});

const SHEET_SYSTEM = `You build a fact sheet for a news agency that only prints what at least two outlets independently report.
You get the EVENT (a working headline) and claims from several reports of it. Each claim has an id like R2.3 (report 2, claim 3).
1. "conflicts": first find every point on which reports contradict each other (different numbers, names, dates, times, places, or opposite statements). For each, list the ids of the claims involved and a short note naming the disputed point in plain words. "At least 10" versus "12" is a conflict. Do not put claim ids inside the note.
2. "facts": group claims from DIFFERENT reports that assert the same fact. For each group write one neutral sentence containing only what every claim in the group agrees on, and list those claim ids in "support". If one report is more specific than another, keep only the part both state. A claim that bundles several details may support a fact about one of its details. A fact must NOT state or imply any disputed point: leave the disputed detail out entirely (if outlets disagree on how many were injured, the fact may say an attack happened but must give no number). Include a fact only if claims from at least two different reports support it.
3. Give every fact a "role":
   - "core": what happened. The fact(s) a one-sentence account of THIS event must contain: the happening itself, with who, where and when if agreed.
   - "supporting": details of this event that matter: figures, what was said or decided, consequences, what happens next.
   - "background": true context that is not news today: job titles, earlier history, standing descriptions of people or organisations.
   - "other_event": about a different happening than the EVENT, even one involving the same people (another announcement, another film, another match, a reaction to something else). These are dropped.
Never add knowledge of your own. Never merge claims that are merely related.
Return {"conflicts":[{"note":"...","claims":["R1.4","R2.2"]}],"facts":[{"text":"...","support":["R1.2","R3.1"],"role":"core"}]}. Every id must be written out in full.`;

export interface ReportClaims {
  report: OutletReport;
  claims: string[];
}

export interface SheetResult {
  facts: { text: string; role: FactRole; reportIds: number[] }[];
  conflicts: { text: string; reportIds: number[] }[];
  /** Facts the model placed in a different event; dropped. */
  offEvent: number;
}

const ID = /\[?\bR(\d+)\.(\d+)(?:\s*[-–]\s*(?:R?\d+\.)?\d+)?\b\]?/g;

/** Conflict notes are for people: swap any internal claim id for the outlet's name. */
export function humaniseNote(note: string, outletOf: (reportIndex: number) => string | undefined): string {
  let out = note.replace(ID, (_m, r: string) => outletOf(Number(r)) ?? "one report");
  // "The Hindu, The Hindu and The Hindu state" -> "The Hindu state"
  for (let i = 0; i < 6; i++) out = out.replace(/\b([A-Z][A-Za-z ]{2,30}?)(?:,| and|, and)\s+\1\b/g, "$1");
  return out.replace(/\s+/g, " ").replace(/\s+([,.;:])/g, "$1").trim();
}

/**
 * Cross-match per-report claims into a fact sheet. Pure apart from the model
 * call, so the corroboration rule can be unit-tested with a fake model.
 */
export async function buildFactSheet(
  llm: Llm,
  meter: Meter,
  input: ReportClaims[],
  minOutlets: number,
  eventLabel = "",
): Promise<SheetResult> {
  const withClaims = input.filter((r) => r.claims.length);
  if (independentGroups(withClaims.map((r) => r.report)).length < minOutlets) return { facts: [], conflicts: [], offEvent: 0 };

  const idToReport = new Map<string, OutletReport>();
  const lines: string[] = eventLabel ? [`EVENT: ${eventLabel}`, ""] : [];
  withClaims.forEach((r, ri) => {
    lines.push(`REPORT R${ri + 1}${r.report.title ? ` (headline: ${r.report.title})` : ""}`);
    r.claims.forEach((c, ci) => {
      const id = `R${ri + 1}.${ci + 1}`;
      idToReport.set(id, r.report);
      lines.push(`${id}: ${c}`);
    });
    lines.push("");
  });

  const res = await llm.json({
    tier: "strong",
    system: SHEET_SYSTEM,
    user: lines.join("\n"),
    schema: sheetSchema,
    meter,
    maxTokens: 24000, // includes the model's reasoning, which is long for big events
  });

  const norm = (id: string) => id.trim().replace(/^\[|\]$/g, "");
  const nameOf = (reportIndex: number) => {
    const r = withClaims[reportIndex - 1]?.report;
    return r ? outletName(r.outletId) : undefined;
  };
  const conflictSets: Set<string>[] = [];
  const conflicts: SheetResult["conflicts"] = [];
  for (const c of res.conflicts) {
    const ids = c.claims.map(norm).filter((id) => idToReport.has(id));
    if (!ids.length) continue;
    conflictSets.push(new Set(ids));
    conflicts.push({ text: humaniseNote(c.note, nameOf), reportIds: [...new Set(ids.map((id) => idToReport.get(id)!.id))] });
  }

  const facts: SheetResult["facts"] = [];
  const seen = new Set<string>();
  let offEvent = 0;
  for (const f of res.facts) {
    // Claims about a different event than this one are dropped.
    if (f.role === "other_event") {
      offEvent++;
      continue;
    }
    const ids = f.support.map(norm).filter((id) => idToReport.has(id));
    if (!ids.length) continue;
    // Conflicting claims are left out: a "fact" resting entirely on claims
    // that are party to one dispute is that dispute, however it is worded.
    // (A bundled claim can still back an undisputed detail; the disputed
    // points themselves go to the Rewrite Desk and Copy Editor as off-limits.)
    if (conflictSets.some((set) => ids.every((id) => set.has(id)))) continue;
    const reports = [...new Map(ids.map((id) => [idToReport.get(id)!.id, idToReport.get(id)!])).values()];
    // The rule, enforced here: independent outlets, wire copies counted once.
    if (independentGroups(reports).length < minOutlets) continue;
    const key = f.text.toLowerCase().trim();
    if (seen.has(key)) continue;
    seen.add(key);
    facts.push({ text: f.text.trim(), role: f.role, reportIds: reports.map((r) => r.id) });
  }
  return { facts, conflicts, offEvent };
}

/** A fact sheet can carry a story only if it has enough claims and at least one core claim. */
export function sheetProblem(facts: { role: FactRole }[], minClaims: number): string | null {
  if (facts.length < minClaims) {
    return `only ${facts.length} claim${facts.length === 1 ? "" : "s"} matched across outlets (need ${minClaims})`;
  }
  if (!facts.some((f) => f.role === "core")) return "no corroborated core claim (outlets agree only on side details)";
  return null;
}

export type FactCheckOutcome =
  | { kind: "waiting"; note: string; changed: boolean }
  | { kind: "expired"; note: string }
  | { kind: "unchanged" }
  | { kind: "ready"; note: string; facts: Fact[]; disputed: string[]; outletCount: number };

/** An event's usable reports: live blogs and live-score pages never count. */
export const eventReports = (ctx: Pick<Ctx, "db">, eventId: number) =>
  (ctx.db.prepare("SELECT * FROM reports WHERE event_id = ? ORDER BY published_at DESC").all(eventId) as unknown as ReportRow[])
    .filter((r) => !isLiveBlog(r.url, r.title));

/** Cheap check, no network and no model: can this event go forward at all? */
export function precheck(ctx: Ctx, ev: EventRow): FactCheckOutcome | { kind: "go"; reports: ReportRow[] } {
  const reports = eventReports(ctx, ev.id);
  const q = qualifies(reports.map(toOutletReport), env.minOutlets);
  if (ctx.now().toISOString() >= ev.expires_at && !q.ok) {
    return {
      kind: "expired",
      note: `Expired after ${env.waitingTtlHours}h without a second independent outlet (${q.reason})`,
    };
  }
  if (!q.ok) {
    const names = [...new Set(reports.map((r) => outletName(r.outlet_id)))].join(", ") || "live pages only";
    const note = `Waiting: ${q.reason}. Reported by ${names}`;
    return { kind: "waiting", note, changed: note !== ev.status_note };
  }
  if (!ev.facts_stale) {
    if (ctx.now().toISOString() >= ev.expires_at) {
      return { kind: "expired", note: `Expired after ${env.waitingTtlHours}h: ${ev.status_note ?? "no usable fact sheet"}` };
    }
    return { kind: "unchanged" };
  }
  return { kind: "go", reports };
}

/** Pick which reports to read: spread across outlets first, newest first, capped. */
function chooseReports(reports: ReportRow[]): ReportRow[] {
  const byOutlet = new Map<string, ReportRow[]>();
  for (const r of reports) byOutlet.set(r.outlet_id, [...(byOutlet.get(r.outlet_id) ?? []), r]);
  const out: ReportRow[] = [];
  for (let round = 0; out.length < MAX_REPORTS_READ; round++) {
    let added = false;
    for (const list of byOutlet.values()) {
      if (list[round] && out.length < MAX_REPORTS_READ) {
        out.push(list[round]);
        added = true;
      }
    }
    if (!added) break;
  }
  return out;
}

/** Read one report (once, ever) and store its claims, wire credit and fingerprint. */
async function readReport(ctx: Ctx, meter: Meter, r: ReportRow): Promise<void> {
  // "feed" outlets: the article page is never requested.
  const article = fetchModeOf(r.outlet_id) === "full" ? await ctx.fetchArticle(r.url).catch(() => null) : null;
  // The article text lives only in this function.
  const text = article?.text ?? `${r.title}. ${r.summary}`.trim();
  const wire = detectWireAgency({ author: article?.author ?? r.byline ?? null, text });
  const fp = article ? fingerprint(article.text) : null;
  const res = await ctx.llm.json({
    tier: "strong",
    system: CLAIMS_SYSTEM,
    user: article
      ? `Outlet: ${outletName(r.outlet_id)}\nHeadline: ${r.title}\n\n${text}`
      : `Outlet: ${outletName(r.outlet_id)}\n(Only the headline and the feed's summary are available.)\nHeadline: ${r.title}\nSummary: ${r.summary || "(none)"}`,
    schema: claimsSchema,
    meter,
    maxTokens: 4000,
    light: true,
  });
  const db = ctx.db;
  db.exec("BEGIN");
  try {
    db.prepare("DELETE FROM report_claims WHERE report_id = ?").run(r.id);
    const ins = db.prepare("INSERT INTO report_claims (report_id, text) VALUES (?, ?)");
    for (const c of res.claims.slice(0, 12)) ins.run(r.id, c.trim());
    db.prepare("UPDATE reports SET text_source = ?, wire_agency = ?, fingerprint = ?, claims_at = ? WHERE id = ?").run(
      article ? "article" : "feed_summary", wire, fp ? JSON.stringify(fp) : null, ctx.now().toISOString(), r.id,
    );
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

/** The full check for an event that passed the precheck. */
export async function factCheck(ctx: Ctx, ev: EventRow, meter: Meter): Promise<FactCheckOutcome> {
  const db = ctx.db;
  const chosen = chooseReports(eventReports(ctx, ev.id));
  // Reports are read side by side; the fetcher still spaces requests per outlet.
  await Promise.all(chosen.filter((r) => !r.claims_at).map((r) => readReport(ctx, meter, r)));

  const read = db
    .prepare(`SELECT * FROM reports WHERE id IN (${chosen.map(() => "?").join(",")})`)
    .all(...chosen.map((r) => r.id)) as unknown as ReportRow[];

  // Now that we have read them, wire copies are visible: re-apply the rule.
  const q = qualifies(read.map(toOutletReport), env.minOutlets);
  db.prepare("UPDATE events SET outlet_count = ?, facts_stale = 0 WHERE id = ?").run(q.count, ev.id);
  if (!q.ok) {
    const wires = [...new Set(read.map((r) => r.wire_agency).filter(Boolean))].join("/");
    return { kind: "waiting", note: `Waiting: ${q.reason}${wires ? ` [${wires}]` : ""}`, changed: true };
  }

  const claimRows = db.prepare("SELECT text FROM report_claims WHERE report_id = ? ORDER BY id");
  const input: ReportClaims[] = read.map((r) => ({
    report: toOutletReport(r),
    claims: (claimRows.all(r.id) as { text: string }[]).map((c) => c.text),
  }));
  const sheet = await buildFactSheet(ctx.llm, meter, input, env.minOutlets, ev.label);

  // Replace the event's fact sheet.
  const iso = ctx.now().toISOString();
  const facts: Fact[] = [];
  db.exec("BEGIN");
  try {
    db.prepare("DELETE FROM fact_claims WHERE event_id = ?").run(ev.id);
    const insClaim = db.prepare("INSERT INTO fact_claims (event_id, text, status, role, created_at) VALUES (?, ?, ?, ?, ?)");
    const insSupport = db.prepare("INSERT OR IGNORE INTO fact_claim_support (fact_claim_id, report_id) VALUES (?, ?)");
    for (const f of sheet.facts) {
      const id = Number(insClaim.run(ev.id, f.text, "corroborated", f.role, iso).lastInsertRowid);
      for (const rid of f.reportIds) insSupport.run(id, rid);
      facts.push({ id, text: f.text, role: f.role, reportIds: f.reportIds });
    }
    for (const c of sheet.conflicts) {
      const id = Number(insClaim.run(ev.id, c.text, "conflicting", "supporting", iso).lastInsertRowid);
      for (const rid of c.reportIds) insSupport.run(id, rid);
    }
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }

  const behind = read.filter((r) => facts.some((f) => f.reportIds.includes(r.id))).map(toOutletReport);
  const outletCount = independentGroups(behind).length;
  db.prepare("UPDATE events SET outlet_count = ? WHERE id = ?").run(facts.length ? outletCount : q.count, ev.id);

  const left =
    (sheet.conflicts.length ? `; ${sheet.conflicts.length} conflicting point${sheet.conflicts.length > 1 ? "s" : ""} left out` : "") +
    (sheet.offEvent ? `; ${sheet.offEvent} claim${sheet.offEvent > 1 ? "s" : ""} about another event dropped` : "");
  const problem = sheetProblem(facts, env.minClaims) ?? (outletCount < env.minOutlets ? "claims trace to one independent source" : null);
  if (problem) {
    return { kind: "waiting", changed: true, note: `Waiting: ${q.count} outlets reported it but ${problem}${left}` };
  }
  const names = [...new Set(read.filter((r) => behind.some((b) => b.id === r.id)).map((r) => outletName(r.outlet_id)))].join(", ");
  const core = facts.filter((f) => f.role === "core").length;
  return {
    kind: "ready",
    facts,
    disputed: sheet.conflicts.map((c) => c.text),
    outletCount,
    note: `Fact sheet of ${facts.length} claims (${core} core), each backed by 2+ of ${outletCount} independent outlets (${names})${left}`,
  };
}
