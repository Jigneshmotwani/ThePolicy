import { z } from "zod";
import type { Llm, Meter } from "@/lib/llm";
import { splitSentences } from "@/lib/text";
import { sheetText } from "./rewriteDesk";
import type { Draft, Fact } from "./types";

/**
 * Copy Editor: a separate strong-model call checks every sentence of the
 * draft (headline included) against the fact sheet. Anything unsupported gets
 * one rewrite attempt; if the rewrite still has an unsupported sentence the
 * story is spiked.
 */

const verdictSchema = z.object({
  sentences: z.array(
    z.object({
      i: z.number().int(),
      supported: z.boolean(),
      facts: z.array(z.string()).default([]),
      problem: z.string().default(""),
    }),
  ),
});

const SYSTEM = `You are the copy editor of a news agency that prints only corroborated facts. You did not write the draft and you owe it nothing.
You get a FACT SHEET (F1, F2, ...) and a numbered list of sentences from a draft (S0 is the headline).
For EACH sentence decide whether EVERYTHING it asserts is stated on the fact sheet.
- "supported": true only if every name, number, date, place, cause, quote, attribution and implication in the sentence is backed by the listed facts. List the fact ids that back it in "facts".
- "supported": false if any part goes beyond the sheet, contradicts it, firms up something the sheet only attributes ("police said X" printed as plain X), or adds judgement or speculation. Say what is unsupported in "problem".
- If the sheet lists points DISPUTED between outlets, any sentence that states or implies one version of a disputed point is unsupported.
Use only the fact sheet, not your own knowledge. If unsure, mark it false.
Return {"sentences":[{"i":0,"supported":true,"facts":["F1"],"problem":""}, ...]} with one entry per sentence.`;

export interface SentenceProblem {
  sentence: string;
  problem: string;
}

/** One checking pass. Returns the unsupported sentences (empty = clean). */
export async function checkDraft(llm: Llm, meter: Meter, facts: Fact[], draft: Draft, disputed: string[] = []): Promise<SentenceProblem[]> {
  const sentences = [draft.headline, ...splitSentences(draft.body)];
  const factIds = new Set(facts.map((_, i) => `F${i + 1}`));
  const res = await llm.json({
    tier: "strong",
    system: SYSTEM,
    user:
      `FACT SHEET\n${sheetText(facts, disputed)}\n\n` +
      `DRAFT SENTENCES\n${sentences.map((s, i) => `S${i}${i === 0 ? " (headline)" : ""}: ${s}`).join("\n")}`,
    schema: verdictSchema,
    check: (v) => {
      for (let i = 0; i < sentences.length; i++) {
        if (!v.sentences.some((s) => s.i === i)) return `missing a verdict for sentence S${i}`;
      }
      return null;
    },
    meter,
    maxTokens: 12000,
  });

  const problems: SentenceProblem[] = [];
  sentences.forEach((sentence, i) => {
    const v = res.sentences.find((s) => s.i === i)!;
    const cited = v.facts.map((f) => f.trim().toUpperCase()).filter((f) => factIds.has(f));
    // A sentence passes only with a positive verdict AND at least one real fact cited.
    if (!v.supported) problems.push({ sentence, problem: v.problem || "not supported by the fact sheet" });
    else if (!cited.length) problems.push({ sentence, problem: "the check cited no fact from the sheet for this sentence" });
  });
  return problems;
}

export type CopyDeskResult =
  | { outcome: "passed"; draft: Draft; rewrites: 0 | 1 }
  | { outcome: "spiked"; draft: Draft; problems: SentenceProblem[] };

/**
 * The Copy Editor's procedure: check, allow exactly one rewrite, check again,
 * spike if anything is still unsupported. The two hooks let the caller log
 * each pass as its own step; tests pass plain functions.
 */
export async function copyDesk(
  draft: Draft,
  hooks: {
    check: (draft: Draft, pass: 1 | 2) => Promise<SentenceProblem[]>;
    rewrite: (draft: Draft, problems: SentenceProblem[]) => Promise<Draft>;
  },
): Promise<CopyDeskResult> {
  const first = await hooks.check(draft, 1);
  if (!first.length) return { outcome: "passed", draft, rewrites: 0 };
  const revised = await hooks.rewrite(draft, first);
  const second = await hooks.check(revised, 2);
  if (!second.length) return { outcome: "passed", draft: revised, rewrites: 1 };
  return { outcome: "spiked", draft: revised, problems: second };
}
