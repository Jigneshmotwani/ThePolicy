import { DESKS, type Desk } from "../../config/sources";
import { getSetting, nowIso, setSetting, type Db } from "./db";
import { outletsBehind } from "../pipeline/pressRoom";

/**
 * What an editor can do from the console. Every function here is a plain
 * database change (the web app and the worker are separate processes sharing
 * SQLite), and every one is recorded in admin_actions with its time.
 *
 * None of these can put a single-source story in the feed: printing always
 * goes through outletsBehind(), the same recount the Press Room uses.
 */

export interface ActionResult {
  ok: boolean;
  message: string;
}

export function logAction(db: Db, action: string, eventId: number | null, detail = "", actor = "editor", at = nowIso()) {
  db.prepare("INSERT INTO admin_actions (at, actor, action, event_id, detail) VALUES (?, ?, ?, ?, ?)").run(at, actor, action, eventId, detail);
}

interface Ev {
  id: number;
  status: string;
  status_reason: string | null;
  headline: string | null;
  desk: string;
}
const getEvent = (db: Db, id: number) =>
  db.prepare("SELECT id, status, status_reason, headline, desk FROM events WHERE id = ?").get(id) as Ev | undefined;

const move = (db: Db, id: number, from: string[], status: string, reason: string | null, note: string, extra = "") =>
  Number(
    db
      .prepare(
        `UPDATE events SET status = ?, status_reason = ?, status_note = ?, updated_at = ?, current_agent = NULL ${extra}
         WHERE id = ? AND status IN (${from.map(() => "?").join(",")})`,
      )
      .run(status, reason, note, nowIso(), id, ...from).changes,
  ) > 0;

const hasArticle = (db: Db, ev: Ev) =>
  !!ev.headline && !!db.prepare("SELECT 1 FROM angles WHERE event_id = ? AND angle_key = 'general'").get(ev.id);

/** Print a held story, if and only if it is complete and two independent outlets stand behind it. */
function printHeld(db: Db, ev: Ev, actor: string): ActionResult {
  if (getSetting(db, "presses_stopped") === "1") return { ok: false, message: "The presses are stopped. Restart them before printing." };
  if (!hasArticle(db, ev)) return { ok: false, message: "This story has no checked article yet, so there is nothing to print." };
  const q = outletsBehind(db, ev.id);
  if (!q.ok) return { ok: false, message: `Not printed: ${q.reason}. A story needs two independent outlets, whoever approves it.` };
  const at = nowIso();
  const done =
    Number(
      db
        .prepare(
          `UPDATE events SET status = 'printed', status_reason = NULL, status_note = ?, printed_at = ?, outlet_count = ?, updated_at = ?
           WHERE id = ? AND status = 'held'`,
        )
        .run(`Printed on an editor's approval with ${q.count} outlets behind it`, at, q.count, at, ev.id).changes,
    ) > 0;
  if (!done) return { ok: false, message: "The story is no longer held." };
  logAction(db, "approve_print", ev.id, `${q.count} independent outlets`, actor, at);
  return { ok: true, message: "Printed. It is in the feed now." };
}

/** Approve a held story: print it if it is ready, otherwise release it back to the desks. */
export function approveStory(db: Db, id: number): ActionResult {
  const ev = getEvent(db, id);
  if (!ev) return { ok: false, message: "No such story." };
  if (ev.status !== "held") return { ok: false, message: "Only a held story can be approved." };
  if (hasArticle(db, ev)) return printHeld(db, ev, "editor");
  // Held before anything was written: release it, and the pipeline takes it from the top.
  move(db, id, ["held"], "waiting", null, "Released by an editor; back in the queue", ", facts_stale = 1");
  logAction(db, "release_hold", id);
  return { ok: true, message: "Hold released. The story goes back through the checks." };
}

export function holdStory(db: Db, id: number): ActionResult {
  if (!move(db, id, ["waiting", "working"], "held", "editor_hold", "Held by an editor")) {
    return { ok: false, message: "Only a story that is waiting or on the desks can be held." };
  }
  logAction(db, "hold", id);
  return { ok: true, message: "Held. Nothing reaches the feed until you approve it." };
}

export function spikeStory(db: Db, id: number, reason = ""): ActionResult {
  if (!move(db, id, ["waiting", "working", "held"], "spiked", "editor_spike", `Spiked by an editor${reason ? `: ${reason}` : ""}`)) {
    return { ok: false, message: "Only a story that is waiting, on the desks or held can be spiked." };
  }
  logAction(db, "spike", id, reason);
  return { ok: true, message: "Spiked. This story will not be printed." };
}

/** Take a printed story out of the feed. The feed only ever reads status = 'printed', so this is immediate. */
export function retractStory(db: Db, id: number, reason: string, actor = "editor"): ActionResult {
  const why = reason.trim();
  if (!why) return { ok: false, message: "Give a reason for the retraction." };
  if (!move(db, id, ["printed"], "retracted", "retracted", `Retracted: ${why}`, ", retracted_at = '" + nowIso() + "'")) {
    return { ok: false, message: "Only a printed story can be retracted." };
  }
  logAction(db, "retract", id, why, actor);
  return { ok: true, message: "Retracted. It has left the feed." };
}

export function setPresses(db: Db, stopped: boolean): ActionResult {
  setSetting(db, "presses_stopped", stopped ? "1" : "0");
  logAction(db, stopped ? "stop_presses" : "restart_presses", null);
  let released = 0;
  if (!stopped) {
    // Stories that were finished but caught by the stop: apply their desk's rule now.
    const caught = db.prepare("SELECT id, status, status_reason, headline, desk FROM events WHERE status = 'held' AND status_reason = 'presses_stopped'").all() as unknown as Ev[];
    for (const ev of caught) {
      const rule = (db.prepare("SELECT rule FROM desk_rules WHERE desk = ?").get(ev.desk) as { rule: string } | undefined)?.rule;
      if (rule === "auto") {
        if (printHeld(db, ev, "press room").ok) released++;
      } else {
        db.prepare("UPDATE events SET status_reason = 'desk_review', status_note = 'Held for review: desk rule is review' WHERE id = ?").run(ev.id);
      }
    }
  }
  return {
    ok: true,
    message: stopped ? "Presses stopped. Nothing new will print." : `Presses running.${released ? ` ${released} finished stor${released === 1 ? "y" : "ies"} printed.` : ""}`,
  };
}

export function setDeskRule(db: Db, desk: string, rule: string): ActionResult {
  if (!(DESKS as readonly string[]).includes(desk) || (rule !== "auto" && rule !== "review")) {
    return { ok: false, message: "Unknown desk or rule." };
  }
  db.prepare("INSERT INTO desk_rules (desk, rule) VALUES (?, ?) ON CONFLICT(desk) DO UPDATE SET rule = excluded.rule").run(desk, rule);
  logAction(db, "desk_rule", null, `${desk}: ${rule === "auto" ? "auto-print" : "review first"}`);
  return { ok: true, message: `${desk}: ${rule === "auto" ? "auto-print" : "review first"}.` };
}

/** Ask the worker for a sweep now. It picks this up within a few seconds. */
export function requestSweep(db: Db): ActionResult {
  const pending = db.prepare("SELECT 1 FROM worker_commands WHERE kind = 'sweep_now' AND picked_at IS NULL").get();
  if (!pending) db.prepare("INSERT INTO worker_commands (kind, created_at) VALUES ('sweep_now', ?)").run(nowIso());
  logAction(db, "sweep_now", null);
  return { ok: true, message: "Sweep requested. The worker starts it within about ten seconds." };
}

/** Queue a link or a topic for the desks. The worker does the work; this only records the request. */
export function submitLead(db: Db, input: string, desk: string): ActionResult & { id?: number } {
  const text = input.trim();
  if (!text) return { ok: false, message: "Add a link or a topic first." };
  if (text.length > 500) return { ok: false, message: "That is too long. Paste one link, or a short topic." };
  if (!(DESKS as readonly string[]).includes(desk)) return { ok: false, message: "Pick a desk." };
  const kind = /^https?:\/\/\S+$/i.test(text) ? "link" : "topic";
  if (kind === "topic" && /^https?:/i.test(text)) return { ok: false, message: "That looks like a broken link. Paste the whole address." };
  const id = Number(
    db.prepare("INSERT INTO submissions (created_at, input, kind, desk) VALUES (?, ?, ?, ?)").run(nowIso(), text, kind, desk as Desk).lastInsertRowid,
  );
  logAction(db, "submit", null, `${kind}: ${text}`);
  return { ok: true, message: "Sent to the desk.", id };
}
