/**
 * npm run report [-- <n>]
 * Prints what is in the database as Markdown: story counts by status, each
 * sweep's tokens and cost, the waiting list, and the latest n printed stories
 * with their fact sheets and source links.
 */
import { getDb } from "../src/lib/db";
import { outletName } from "../config/sources";

const n = Number(process.argv[2]) || 5;
const db = getDb();
const all = <T>(sql: string, ...args: (string | number)[]) => db.prepare(sql).all(...args) as T[];

console.log("## Stories by status\n");
for (const r of all<{ status: string; status_reason: string | null; n: number }>(
  "SELECT status, status_reason, COUNT(*) n FROM events GROUP BY 1, 2 ORDER BY 1, 2",
)) console.log(`- ${r.status}${r.status_reason ? ` (${r.status_reason})` : ""}: ${r.n}`);

console.log("\n## Sweeps\n\n| Sweep | Started (UTC) | Duration | New reports | Events to the desks | Printed | Held | Spiked | Back to waiting | Failed | Waiting after | Model calls | Tokens in | Tokens out | Cost USD |\n|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|");
const mmss = (sec: number) => `${Math.floor(sec / 60)}m ${String(sec % 60).padStart(2, "0")}s`;
for (const s of all<{ id: number; started_at: string; summary: string | null }>("SELECT * FROM sweeps ORDER BY id")) {
  const x = s.summary ? JSON.parse(s.summary) : null;
  console.log(x
    ? `| ${s.id}${x.error ? " (FAILED)" : ""}${x.budgetStopped ? " (budget)" : ""} | ${s.started_at.slice(0, 16).replace("T", " ")} | ${mmss(x.seconds)} | ${x.newReports} | ${x.taken ?? "-"} | ${x.printed} | ${x.held} | ${x.spiked} | ${x.backToWaiting ?? "-"} | ${x.failed ?? "-"} | ${x.waiting} | ${x.llmCalls} | ${x.promptTokens} | ${x.completionTokens} | ${x.costUsd.toFixed(4)} |`
    : `| ${s.id} | ${s.started_at.slice(0, 16).replace("T", " ")} | (did not finish) |`);
}

// Does rechecking waiting events cost model calls? Count the calls on the recheck steps themselves.
const recheck = db.prepare("SELECT COUNT(*) n, COALESCE(SUM(llm_calls), 0) calls FROM steps WHERE agent = 'Fact Checker' AND note LIKE 'Waiting:%' AND started_at = ended_at").get() as { n: number; calls: number };
console.log(`\nWaiting-recheck steps written: ${recheck.n}; model calls on them: ${recheck.calls}.`);

console.log("\n## Tokens and cost by agent (all sweeps)\n\n| Agent | Steps | Model calls | Tokens in | Tokens out | Cost USD |\n|---|---|---|---|---|---|");
for (const a of all<{ agent: string; steps: number; calls: number; p: number; c: number; usd: number }>(
  "SELECT agent, COUNT(*) steps, SUM(llm_calls) calls, SUM(prompt_tokens) p, SUM(completion_tokens) c, SUM(cost_usd) usd FROM steps GROUP BY agent ORDER BY usd DESC",
)) console.log(`| ${a.agent} | ${a.steps} | ${a.calls} | ${a.p} | ${a.c} | ${a.usd.toFixed(4)} |`);

console.log("\n## Waiting (first 10)\n");
for (const e of all<{ id: number; label: string; status_note: string; recheck_count: number }>(
  "SELECT id, label, status_note, recheck_count FROM events WHERE status = 'waiting' ORDER BY id LIMIT 10",
)) console.log(`- #${e.id} ${e.label}\n  - ${e.status_note} (rechecked ${e.recheck_count}x)`);

console.log(`\n## Latest ${n} printed stories\n`);
for (const e of all<{ id: number; desk: string; headline: string; printed_at: string; outlet_count: number }>(
  "SELECT id, desk, headline, printed_at, outlet_count FROM events WHERE status = 'printed' ORDER BY printed_at DESC, id DESC LIMIT ?", n,
)) {
  const angle = db.prepare("SELECT body, word_count FROM angles WHERE event_id = ? AND angle_key = 'general'").get(e.id) as { body: string; word_count: number };
  console.log(`### ${e.headline}\n\n*${e.desk} desk · event #${e.id} · printed ${e.printed_at.slice(0, 16).replace("T", " ")} UTC · ${e.outlet_count} independent outlets · headline ${e.headline.length} chars · body ${angle.word_count} words*\n\n> ${angle.body}\n\n**Fact sheet**\n`);
  for (const c of all<{ id: number; text: string; status: string; role: string }>("SELECT id, text, status, role FROM fact_claims WHERE event_id = ? ORDER BY status DESC, CASE role WHEN 'core' THEN 0 WHEN 'supporting' THEN 1 ELSE 2 END, id", e.id)) {
    const outlets = all<{ outlet_id: string }>(
      "SELECT DISTINCT r.outlet_id FROM fact_claim_support s JOIN reports r ON r.id = s.report_id WHERE s.fact_claim_id = ?", c.id,
    ).map((r) => outletName(r.outlet_id));
    console.log(`- ${c.status === "conflicting" ? "*(left out: outlets conflict)* " : `**${c.role}** · `}${c.text} — ${outlets.join(", ")}`);
  }
  console.log("\n**Sources**\n");
  for (const r of all<{ outlet_id: string; url: string; title: string; wire_agency: string | null; text_source: string | null }>(
    `SELECT DISTINCT r.outlet_id, r.url, r.title, r.wire_agency, r.text_source FROM reports r
     JOIN fact_claim_support s ON s.report_id = r.id JOIN fact_claims c ON c.id = s.fact_claim_id
     WHERE c.event_id = ? AND c.status = 'corroborated' ORDER BY r.outlet_id`, e.id,
  )) console.log(`- ${outletName(r.outlet_id)}${r.wire_agency ? ` (${r.wire_agency} copy)` : ""}${r.text_source === "feed_summary" ? " (headline and feed summary only)" : ""}: [${r.title}](${r.url})`);
  console.log("");
}
