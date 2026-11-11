import { z } from "zod";
import { DESK_LABELS, type Desk } from "@config/sources";
import type { Llm, Meter } from "@/lib/llm";
import { wordCount } from "@/lib/text";
import type { Draft, Fact } from "./types";

/**
 * Rewrite Desk: write the headline and the short body from the fact sheet and
 * nothing else. It never sees the outlets' articles.
 */

export const HEADLINE_MAX = 60;
export const BODY_MIN_WORDS = 45;
export const BODY_MAX_WORDS = 60;

const draftSchema = z.object({ headline: z.string().min(8), body: z.string().min(40) });

const SYSTEM = `You are the rewrite desk of a news agency. You write a short news item from a FACT SHEET and from nothing else.
Hard rules:
- Use only facts F1, F2, ... on the sheet. If the sheet lists points DISPUTED between outlets, do not mention them at all.
- Do not add names, numbers, dates, places, causes, context, background or consequences that are not on it, even if you know them.
- Original wording: plain sentences of your own. Neutral tone: no adjectives of judgement, no drama, no speculation, no advice to the reader.
- Keep attribution where the sheet has it ("police said").
- Headline: at most ${HEADLINE_MAX} characters, sentence case, no full stop, no clickbait.
- Body: one paragraph of ${BODY_MIN_WORDS} to ${BODY_MAX_WORDS} words. Complete sentences. Lead with the most important fact. You need not use every fact.
- Plain text only: no markdown, no quotation marks unless the sheet quotes.
Return {"headline":"...","body":"..."}.`;

export function lengthProblem(d: Draft): string | null {
  const h = d.headline.trim().length;
  if (h > HEADLINE_MAX) return `headline is ${h} characters; the limit is ${HEADLINE_MAX}`;
  const w = wordCount(d.body);
  if (w < BODY_MIN_WORDS || w > BODY_MAX_WORDS) return `body is ${w} words; it must be ${BODY_MIN_WORDS} to ${BODY_MAX_WORDS}`;
  if (/[\n*#_`]/.test(d.body)) return "body must be one plain-text paragraph without markdown";
  return null;
}

export const sheetText = (facts: Fact[], disputed: string[] = []) =>
  facts.map((f, i) => `F${i + 1}. ${f.text}`).join("\n") +
  (disputed.length ? `\n\nDISPUTED BETWEEN OUTLETS (never state or imply any version of these)\n${disputed.map((d) => `- ${d}`).join("\n")}` : "");
const clean = (d: Draft): Draft => ({ headline: d.headline.trim().replace(/\.$/, ""), body: d.body.replace(/\s+/g, " ").trim() });

export async function writeDraft(llm: Llm, meter: Meter, desk: Desk, facts: Fact[], disputed: string[] = []): Promise<Draft> {
  const d = await llm.json({
    tier: "strong",
    system: SYSTEM,
    user: `Desk: ${DESK_LABELS[desk]}\n\nFACT SHEET\n${sheetText(facts, disputed)}`,
    schema: draftSchema,
    check: (v) => lengthProblem(clean(v)),
    meter,
    maxTokens: 12000,
  });
  return clean(d);
}

/** The Copy Editor's one rewrite attempt: fix the flagged sentences. */
export async function reviseDraft(
  llm: Llm,
  meter: Meter,
  desk: Desk,
  facts: Fact[],
  draft: Draft,
  problems: { sentence: string; problem: string }[],
  disputed: string[] = [],
): Promise<Draft> {
  const d = await llm.json({
    tier: "strong",
    system: SYSTEM,
    user:
      `Desk: ${DESK_LABELS[desk]}\n\nFACT SHEET\n${sheetText(facts, disputed)}\n\n` +
      `YOUR EARLIER DRAFT\nHeadline: ${draft.headline}\nBody: ${draft.body}\n\n` +
      `The copy editor found these parts are NOT supported by the fact sheet:\n` +
      problems.map((p) => `- "${p.sentence}": ${p.problem}`).join("\n") +
      `\n\nRewrite the item so every sentence is fully supported by the fact sheet. Remove or correct the unsupported parts; keep to the length rules.`,
    schema: draftSchema,
    check: (v) => lengthProblem(clean(v)),
    meter,
    maxTokens: 12000,
  });
  return clean(d);
}
