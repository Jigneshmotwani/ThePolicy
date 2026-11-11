import type { Desk } from "@config/sources";
import { getSetting, type Db } from "@/lib/db";

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
