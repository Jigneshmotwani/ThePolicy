import type { Desk } from "@config/sources";
import { getSetting, type Db } from "@/lib/db";
import { env } from "@/lib/env";
import { isLiveBlog } from "./liveblog";
import { qualifies, toOutletReport, type OutletReportRow, type Qualification } from "./outlets";

/**
 * Press Room: the last gate. Publish if the desk's rule is "auto", hold if it
 * is "review". A global "presses stopped" setting holds everything.
 */

export type PressDecision = { action: "print" | "hold"; reason: string | null; note: string };

export function pressDecision(pressesStopped: boolean, rule: string | undefined): PressDecision {
  if (pressesStopped) {
    return { action: "hold", reason: "presses_stopped", note: "Held: the presses are stopped" };
  }
  if (rule === "auto") return { action: "print", reason: null, note: "Printed: desk rule is auto" };
  // Unknown or missing rule: hold rather than publish.
  return { action: "hold", reason: "desk_review", note: `Held for review: desk rule is ${rule ?? "not set"}` };
}

export function readPressRules(db: Db, desk: Desk): { pressesStopped: boolean; rule: string | undefined } {
  return {
    pressesStopped: getSetting(db, "presses_stopped") === "1",
    rule: (db.prepare("SELECT rule FROM desk_rules WHERE desk = ?").get(desk) as { rule: string } | undefined)?.rule,
  };
}

/**
 * Recount, straight from the database, the independent outlets behind an
 * event's corroborated claims. The last line of defence before anything is
 * printed, whoever asks: the Press Room, an editor approving a held story,
 * or the audit. Live pages never count.
 */
export function outletsBehind(db: Db, eventId: number): Qualification {
  const rows = (
    db
      .prepare(
        `SELECT DISTINCT r.id, r.outlet_id, r.wire_agency, r.fingerprint, r.url, r.title, r.byline, r.text_source
         FROM fact_claims c JOIN fact_claim_support s ON s.fact_claim_id = c.id JOIN reports r ON r.id = s.report_id
         WHERE c.event_id = ? AND c.status = 'corroborated'`,
      )
      .all(eventId) as unknown as (OutletReportRow & { url: string; title: string })[]
  ).filter((r) => !isLiveBlog(r.url, r.title));
  return qualifies(rows.map(toOutletReport), env.minOutlets);
}
