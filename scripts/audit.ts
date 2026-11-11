/**
 * npm run audit
 * Re-audit every printed story against the current rules: wire copy
 * (including the URL-slug and unseen-provenance rules) and live pages.
 *
 *  - A claim no longer backed by two independent outlets is removed from the
 *    fact sheet.
 *  - A story with fewer than two independent outlets left is retracted.
 *  - A story that lost claims but kept two outlets has its printed copy
 *    re-checked by the Copy Editor against what remains; if any sentence is
 *    now unsupported, it is retracted.
 * Everything done is recorded in admin_actions (actor "audit").
 */
import { outletName } from "../config/sources";
import { getDb } from "../src/lib/db";
import { env } from "../src/lib/env";
import { listModels, Meter, realLlm } from "../src/lib/llm";
import { logAction, retractStory } from "../src/lib/newsroom";
import { checkDraft } from "../src/pipeline/copyEditor";
import { isLiveBlog } from "../src/pipeline/liveblog";
import { independentGroups, sharedOrigin, toOutletReport, type OutletReportRow } from "../src/pipeline/outlets";
import { outletsBehind } from "../src/pipeline/pressRoom";
import type { Fact, FactRole } from "../src/pipeline/types";

async function main() {
  const db = getDb();
  await listModels().catch(() => undefined);
  const llm = realLlm();
  const printed = db.prepare("SELECT id, headline, outlet_count FROM events WHERE status = 'printed' ORDER BY id").all() as { id: number; headline: string; outlet_count: number }[];
  console.log(`Auditing ${printed.length} printed stories.\n`);
  let retracted = 0;

  for (const ev of printed) {
    const claims = db.prepare("SELECT id, text, role FROM fact_claims WHERE event_id = ? AND status = 'corroborated' ORDER BY id").all(ev.id) as { id: number; text: string; role: FactRole }[];
    const supportOf = db.prepare(
      `SELECT r.id, r.outlet_id, r.wire_agency, r.fingerprint, r.url, r.title, r.byline, r.text_source
       FROM fact_claim_support s JOIN reports r ON r.id = s.report_id WHERE s.fact_claim_id = ?`,
    );
    const lost: string[] = [];
    const notes = new Set<string>();
    for (const c of claims) {
      const rows = supportOf.all(c.id) as unknown as (OutletReportRow & { url: string; title: string })[];
      const live = rows.filter((r) => isLiveBlog(r.url, r.title));
      for (const r of live) notes.add(`${outletName(r.outlet_id)} page is a live blog`);
      const usable = rows.filter((r) => !isLiveBlog(r.url, r.title)).map(toOutletReport);
      for (let i = 0; i < usable.length; i++) {
        for (let j = i + 1; j < usable.length; j++) {
          const why = sharedOrigin(usable[i], usable[j]);
          if (why && usable[i].outletId !== usable[j].outletId) notes.add(`${outletName(usable[i].outletId)} and ${outletName(usable[j].outletId)}: ${why}`);
        }
      }
      if (independentGroups(usable).length < env.minOutlets) {
        lost.push(c.text);
        db.prepare("DELETE FROM fact_claim_support WHERE fact_claim_id = ?").run(c.id);
        db.prepare("DELETE FROM fact_claims WHERE id = ?").run(c.id);
      }
    }
    const q = outletsBehind(db, ev.id);
    const head = `#${ev.id} ${ev.headline}\n   outlets: ${ev.outlet_count} -> ${q.count}; claims: ${claims.length} -> ${claims.length - lost.length}`;
    const why = [...notes].join("; ");

    if (!q.ok) {
      const reason = `Audit: fewer than two independent outlets (${q.reason})${why ? `. ${why}` : ""}`;
      retractStory(db, ev.id, reason, "audit");
      retracted++;
      console.log(`${head}\n   RETRACTED: ${reason}\n`);
      continue;
    }
    db.prepare("UPDATE events SET outlet_count = ? WHERE id = ?").run(q.count, ev.id);
    if (!lost.length) {
      if (q.count !== ev.outlet_count) logAction(db, "audit_recount", ev.id, `Outlet count ${ev.outlet_count} -> ${q.count}. ${why}`, "audit");
      console.log(`${head}\n   kept${why ? ` (${why})` : ""}\n`);
      continue;
    }
    // The fact sheet shrank: does the printed copy still stand on what is left?
    const facts: Fact[] = (db.prepare("SELECT id, text, role FROM fact_claims WHERE event_id = ? AND status = 'corroborated' ORDER BY id").all(ev.id) as { id: number; text: string; role: FactRole }[]).map((f) => ({ ...f, reportIds: [] }));
    const disputed = (db.prepare("SELECT text FROM fact_claims WHERE event_id = ? AND status = 'conflicting'").all(ev.id) as { text: string }[]).map((c) => c.text);
    const body = (db.prepare("SELECT body FROM angles WHERE event_id = ? AND angle_key = 'general'").get(ev.id) as { body: string }).body;
    const meter = new Meter();
    const problems = await checkDraft(llm, meter, facts, { headline: ev.headline, body }, disputed);
    db.prepare(
      "INSERT INTO steps (event_id, agent, status, started_at, ended_at, note, model, prompt_tokens, completion_tokens, llm_calls, cost_usd) VALUES (?, 'Copy Editor', 'ok', ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(ev.id, new Date().toISOString(), new Date().toISOString(),
      `Audit re-check after ${lost.length} claim${lost.length > 1 ? "s" : ""} lost their second source: ${problems.length ? `${problems.length} sentence(s) no longer supported` : "printed copy still fully supported"}`,
      meter.model, meter.promptTokens, meter.completionTokens, meter.calls, meter.costUsd);
    if (problems.length) {
      const reason = `Audit: ${lost.length} claim${lost.length > 1 ? "s" : ""} lost their second independent source and the printed copy relied on them ("${problems[0].sentence.slice(0, 90)}")${why ? `. ${why}` : ""}`;
      retractStory(db, ev.id, reason, "audit");
      retracted++;
      console.log(`${head}\n   RETRACTED: ${reason}\n`);
    } else {
      logAction(db, "audit_recount", ev.id, `Outlet count ${ev.outlet_count} -> ${q.count}; ${lost.length} claim(s) removed; printed copy re-checked and still supported. ${why}`, "audit");
      console.log(`${head}\n   kept: ${lost.length} claim(s) removed, printed copy re-checked and still supported${why ? ` (${why})` : ""}\n`);
    }
  }
  console.log(`Done: ${retracted} retracted, ${printed.length - retracted} kept.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
