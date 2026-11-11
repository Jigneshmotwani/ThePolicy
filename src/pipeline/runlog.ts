import { Meter } from "@/lib/llm";
import { oneLine } from "@/lib/text";
import type { Db } from "@/lib/db";
import type { Agent, Ctx, StoryStatus } from "./types";

export interface StepResult<T> {
  note: string;
  status?: "ok" | "skipped";
  value: T;
}

export function writeStep(
  db: Db,
  row: {
    sweepId: number | null;
    eventId: number | null;
    agent: Agent;
    status: "ok" | "skipped" | "failed";
    startedAt: string;
    endedAt: string;
    note: string;
    meter?: Meter;
  },
) {
  const m = row.meter;
  db.prepare(
    `INSERT INTO steps (sweep_id, event_id, agent, status, started_at, ended_at, note, model,
                        prompt_tokens, completion_tokens, llm_calls, cost_usd)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    row.sweepId, row.eventId, row.agent, row.status, row.startedAt, row.endedAt, oneLine(row.note, 300),
    m?.model ?? null, m?.promptTokens ?? 0, m?.completionTokens ?? 0, m?.calls ?? 0, m?.costUsd ?? 0,
  );
}

/**
 * Run one stage for one event (or sweep-wide when eventId is null) and write
 * its step record whatever happens. A thrown error becomes a "failed" step
 * and is re-thrown so the caller can decide what happens to the story.
 */
export async function runStep<T>(
  ctx: Ctx,
  agent: Agent,
  eventId: number | null,
  fn: (meter: Meter) => Promise<StepResult<T>>,
): Promise<T> {
  const meter = new Meter();
  const startedAt = ctx.now().toISOString();
  try {
    const res = await fn(meter);
    writeStep(ctx.db, {
      sweepId: ctx.sweepId, eventId, agent, status: res.status ?? "ok",
      startedAt, endedAt: ctx.now().toISOString(), note: res.note, meter,
    });
    return res.value;
  } catch (e) {
    writeStep(ctx.db, {
      sweepId: ctx.sweepId, eventId, agent, status: "failed",
      startedAt, endedAt: ctx.now().toISOString(),
      note: `Failed: ${(e as Error)?.message ?? String(e)}`, meter,
    });
    throw e;
  }
}

export function setEventStatus(
  ctx: Ctx,
  eventId: number,
  status: StoryStatus,
  reason: string | null,
  note: string,
  extra: Record<string, string | number | null> = {},
) {
  const cols = Object.keys(extra);
  ctx.db
    .prepare(
      `UPDATE events SET status = ?, status_reason = ?, status_note = ?, updated_at = ?
       ${cols.map((c) => `, ${c} = ?`).join("")} WHERE id = ?`,
    )
    .run(status, reason, oneLine(note, 300), ctx.now().toISOString(), ...cols.map((c) => extra[c]), eventId);
}
