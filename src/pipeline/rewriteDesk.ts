import { z } from "zod";
import { DESK_LABELS, type Desk } from "@config/sources";
import { LlmStepError, type Llm, type Meter } from "@/lib/llm";
import { splitSentences, wordCount } from "@/lib/text";
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
Each fact is marked [core], [supporting] or [background].
What you may say:
- Use only facts F1, F2, ... on the sheet. If the sheet lists points DISPUTED between outlets, do not mention them at all.
- Do not add names, numbers, dates, places, causes, context, background or consequences that are not on it, even if you know them.
- Keep attribution where the sheet has it ("police said").
How it should read: a news paragraph, not a list.
- Lead with the core fact: the first sentence says what happened.
- Then what matters most from the supporting facts, in order of importance. You need not use every fact; leave out the minor ones.
- Connect the sentences so each follows from the one before: carry the subject forward, join related facts in one sentence, vary sentence length. Do not write a string of short flat statements, and do not invent a link (cause, contrast, sequence) the sheet does not state.
- [background] facts appear only in passing, as a few words inside a sentence about something else ("Qantas chief executive Vanessa Hudson said..."). Never give a background fact a sentence of its own.
- Original wording of your own. Neutral tone: no adjectives of judgement, no drama, no speculation, no advice to the reader.
Format:
- Headline: at most ${HEADLINE_MAX} characters, sentence case, no full stop, no clickbait. It states the core fact.
- Body: one paragraph of ${BODY_MIN_WORDS} to ${BODY_MAX_WORDS} words, in two to four complete sentences.
- Plain text only: no markdown, no quotation marks unless the sheet quotes.
Return {"headline":"...","body":"..."}.`;

/**
 * The fact sheet does not hold enough agreed fact to fill the minimum length,
 * and the desk will not pad. Not a failure: the story waits for more.
 */
export class ThinSheetError extends Error {
  constructor(public words: number) {
    super(`could not write ${BODY_MIN_WORDS} words from the fact sheet without padding (best was ${words})`);
    this.name = "ThinSheetError";
  }
}

/** Run a drafting call; if it ends because every attempt came up short, say so as ThinSheetError. */
async function drafting(call: () => Promise<Draft>): Promise<Draft> {
  try {
    return await call();
  } catch (e) {
    const short = e instanceof LlmStepError ? /body is (\d+) words/.exec(e.message) : null;
    if (short && Number(short[1]) < BODY_MIN_WORDS) throw new ThinSheetError(Number(short[1]));
    throw e;
  }
}

export function lengthProblem(d: Draft): string | null {
  const h = d.headline.trim().length;
  if (h > HEADLINE_MAX) return `headline is ${h} characters; the limit is ${HEADLINE_MAX}`;
  const w = wordCount(d.body);
  if (w < BODY_MIN_WORDS || w > BODY_MAX_WORDS) return `body is ${w} words; it must be ${BODY_MIN_WORDS} to ${BODY_MAX_WORDS}`;
  if (/[\n*#_`]/.test(d.body)) return "body must be one plain-text paragraph without markdown";
  const sentences = splitSentences(d.body);
  if (sentences.length < 2 || sentences.length > 4) return `body has ${sentences.length} sentences; write two to four connected sentences`;
  const stub = sentences.find((x) => wordCount(x) < 6);
  if (stub) return `"${stub}" is a stub sentence; fold it into a neighbouring sentence`;
  return null;
}

export const sheetText = (facts: Fact[], disputed: string[] = []) =>
  facts.map((f, i) => `F${i + 1} [${f.role}]. ${f.text}`).join("\n") +
  (disputed.length ? `\n\nDISPUTED BETWEEN OUTLETS (never state or imply any version of these)\n${disputed.map((d) => `- ${d}`).join("\n")}` : "");
const clean = (d: Draft): Draft => ({ headline: d.headline.trim().replace(/\.$/, ""), body: d.body.replace(/\s+/g, " ").trim() });

export async function writeDraft(llm: Llm, meter: Meter, desk: Desk, facts: Fact[], disputed: string[] = []): Promise<Draft> {
  const d = await drafting(() => llm.json({
    tier: "strong",
    system: SYSTEM,
    user: `Desk: ${DESK_LABELS[desk]}\n\nFACT SHEET\n${sheetText(facts, disputed)}`,
    schema: draftSchema,
    check: (v) => lengthProblem(clean(v)),
    meter,
    maxTokens: 6000,
    retryLight: true,
  }));
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
  const d = await drafting(() => llm.json({
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
    maxTokens: 6000,
    retryLight: true,
  }));
  return clean(d);
}
