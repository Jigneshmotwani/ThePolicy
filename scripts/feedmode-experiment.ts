/**
 * npx tsx scripts/feedmode-experiment.ts [maxEvents]
 *
 * How much does reading Indian Express and The Hindu from their feeds only
 * reduce what can be printed? Measured on events whose reports were read in
 * full during iteration 1 (their claims are still stored), without fetching
 * any page again:
 *
 *   FULL  the stored claims, as extracted from the full articles.
 *   FEED  the same events, but for Indian Express and The Hindu the claims
 *         are re-extracted from the stored headline and feed summary only,
 *         and The Hindu's provenance is treated as unseen (its feed has no
 *         byline), exactly as the pipeline now does.
 *
 * Both variants then go through the current fact-sheet code and gates
 * (two independent outlets, MIN_CLAIMS, a core claim). Nothing is written to
 * the stories; one step row records the model cost.
 */
import { z } from "zod";
import { outletName } from "../config/sources";
import { getDb } from "../src/lib/db";
import { env } from "../src/lib/env";
import { listModels, Meter, pool, realLlm } from "../src/lib/llm";
import { buildFactSheet, sheetProblem, type ReportClaims } from "../src/pipeline/factChecker";
import { isLiveBlog } from "../src/pipeline/liveblog";
import { independentGroups, qualifies, toOutletReport } from "../src/pipeline/outlets";
import type { ReportRow } from "../src/pipeline/types";

const FEED_ONLY = new Set(["ie", "hindu"]);
const claimsSchema = z.object({ claims: z.array(z.string().min(8).max(400)).max(16) });
const CLAIMS_SYSTEM = `You extract factual claims from one news report so they can be cross-checked against other outlets.
You are given only a headline and a one-line summary. List only what those state, as atomic claims in your own words (one fact per claim, exact names and numbers kept, statements attributed). Do not expand on them. If they state no fact, return an empty list.
Return {"claims":["...", "..."]}.`;

async function main() {
  const max = Number(process.argv[2]) || 20;
  const db = getDb();
  await listModels();
  const llm = realLlm();
  const meter = new Meter();
  const started = new Date().toISOString();

  const eventIds = (db
    .prepare(
      `SELECT DISTINCT r.event_id AS id FROM reports r
       WHERE r.claims_at IS NOT NULL AND r.text_source = 'article' AND r.outlet_id IN ('ie','hindu') AND r.claims_at < '2026-11-11T18:00:00'
       ORDER BY r.event_id`,
    )
    .all() as { id: number }[]).map((r) => r.id);

  const claimsOf = db.prepare("SELECT text FROM report_claims WHERE report_id = ? ORDER BY id");
  const rows: { id: number; label: string; full: string; feed: string; fullN: number; feedN: number }[] = [];
  const candidates: { id: number; label: string; read: ReportRow[] }[] = [];
  for (const id of eventIds) {
    const read = (db.prepare("SELECT * FROM reports WHERE event_id = ? AND claims_at IS NOT NULL AND claims_at < '2026-11-11T18:00:00'").all(id) as unknown as ReportRow[])
      .filter((r) => !isLiveBlog(r.url, r.title));
    if (!qualifies(read.map(toOutletReport), env.minOutlets).ok) continue;
    const label = (db.prepare("SELECT label FROM events WHERE id = ?").get(id) as { label: string }).label;
    candidates.push({ id, label, read });
    if (candidates.length >= max) break;
  }
  console.log(`${eventIds.length} events had Indian Express or Hindu articles read in full; testing ${candidates.length} that qualified with two outlets.\n`);

  const verdict = async (label: string, input: ReportClaims[]) => {
    const reports = input.map((i) => i.report);
    const q = qualifies(reports, env.minOutlets);
    if (!q.ok) return { ok: false, why: q.reason, n: 0 };
    const sheet = await buildFactSheet(llm, meter, input, env.minOutlets, label);
    const behind = reports.filter((r) => sheet.facts.some((f) => f.reportIds.includes(r.id)));
    const problem = sheetProblem(sheet.facts, env.minClaims) ?? (independentGroups(behind).length < env.minOutlets ? "claims trace to one source" : null);
    return { ok: !problem, why: problem ?? "printable", n: sheet.facts.length };
  };

  await pool(candidates, 4, async (c) => {
    try {
      const full: ReportClaims[] = c.read.map((r) => ({ report: toOutletReport(r), claims: (claimsOf.all(r.id) as { text: string }[]).map((x) => x.text) }));
      const feed: ReportClaims[] = await Promise.all(
        c.read.map(async (r) => {
          if (!FEED_ONLY.has(r.outlet_id)) return full.find((f) => f.report.id === r.id)!;
          const res = await llm.json({
            tier: "strong", light: true, system: CLAIMS_SYSTEM, schema: claimsSchema, meter, maxTokens: 2000,
            user: `Outlet: ${outletName(r.outlet_id)}\nHeadline: ${r.title}\nSummary: ${r.summary || "(none)"}`,
          });
          const asFeed = toOutletReport({ ...r, text_source: "feed_summary", fingerprint: null, wire_agency: r.outlet_id === "hindu" ? null : r.wire_agency, byline: r.outlet_id === "ie" ? "byline" : null });
          return { report: asFeed, claims: res.claims };
        }),
      );
      const [a, b] = [await verdict(c.label, full), await verdict(c.label, feed)];
      rows.push({ id: c.id, label: c.label, full: a.why, feed: b.why, fullN: a.n, feedN: b.n });
    } catch (e) {
      console.log(`  #${c.id} skipped: ${(e as Error).message.slice(0, 100)}`);
    }
  });

  rows.sort((x, y) => x.id - y.id);
  for (const r of rows) console.log(`#${String(r.id).padEnd(4)} FULL ${String(r.fullN).padStart(2)} claims: ${r.full.padEnd(44).slice(0, 44)} | FEED ${String(r.feedN).padStart(2)} claims: ${r.feed.slice(0, 60)}   ${r.label.slice(0, 50)}`);
  const full = rows.filter((r) => r.full === "printable").length;
  const feed = rows.filter((r) => r.feed === "printable").length;
  const avg = (k: "fullN" | "feedN") => (rows.reduce((n, r) => n + r[k], 0) / Math.max(1, rows.length)).toFixed(1);
  console.log(`\n${rows.length} events tested. Printable with full text: ${full}. Printable feed-only: ${feed}. Corroborated claims per event: ${avg("fullN")} -> ${avg("feedN")}.`);
  console.log(`Model cost of this experiment: $${meter.costUsd.toFixed(4)} (${meter.calls} calls).`);
  db.prepare(
    "INSERT INTO steps (agent, status, started_at, ended_at, note, model, prompt_tokens, completion_tokens, llm_calls, cost_usd) VALUES ('Fact Checker', 'ok', ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(started, new Date().toISOString(), `Feed-mode experiment on ${rows.length} events: ${full} printable with full text, ${feed} feed-only (no story was changed)`, meter.model, meter.promptTokens, meter.completionTokens, meter.calls, meter.costUsd);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
