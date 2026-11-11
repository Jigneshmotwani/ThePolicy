import { describe, expect, it } from "vitest";
import { checkDraft, copyDesk } from "@/pipeline/copyEditor";
import { LlmStepError, Meter } from "@/lib/llm";
import type { Draft, Fact } from "@/pipeline/types";
import { scriptedLlm } from "./helpers";

const facts: Fact[] = [
  { id: 1, text: "The state assembly passed the heat-action bill on Tuesday.", reportIds: [1, 2] },
  { id: 2, text: "The bill requires cities to publish a heat plan before each summer.", reportIds: [1, 2] },
];
const good: Draft = {
  headline: "State assembly passes heat-action bill",
  body: "The state assembly passed the heat-action bill on Tuesday. Cities must publish a heat plan before each summer.",
};
const bad: Draft = {
  headline: good.headline,
  body: "The state assembly passed the heat-action bill on Tuesday. The opposition walked out in protest.",
};

/** A copy editor "model" that supports a sentence only if it contains none of the banned phrases. */
const editor = (banned: string[]) =>
  scriptedLlm((_system, user) => {
    const sentences = [...user.matchAll(/^S(\d+)(?: \(headline\))?: (.*)$/gm)];
    return {
      sentences: sentences.map((m) => {
        const hit = banned.find((b) => m[2].includes(b));
        return hit
          ? { i: Number(m[1]), supported: false, facts: [], problem: `"${hit}" is not on the fact sheet` }
          : { i: Number(m[1]), supported: true, facts: ["F1"], problem: "" };
      }),
    };
  });

describe("Copy Editor", () => {
  it("passes copy in which every sentence is supported", async () => {
    const llm = editor(["walked out"]);
    const res = await copyDesk(good, {
      check: (d) => checkDraft(llm, new Meter(), facts, d),
      rewrite: async () => { throw new Error("should not be asked to rewrite"); },
    });
    expect(res).toMatchObject({ outcome: "passed", rewrites: 0 });
  });

  it("flags the unsupported sentence, and only that one", async () => {
    const problems = await checkDraft(editor(["walked out"]), new Meter(), facts, bad);
    expect(problems).toHaveLength(1);
    expect(problems[0].sentence).toBe("The opposition walked out in protest.");
  });

  it("gives an unsupported sentence one rewrite and passes the story if the rewrite is clean", async () => {
    const llm = editor(["walked out"]);
    let rewrites = 0;
    const res = await copyDesk(bad, {
      check: (d) => checkDraft(llm, new Meter(), facts, d),
      rewrite: async (_d, problems) => {
        rewrites++;
        expect(problems[0].sentence).toContain("walked out");
        return good;
      },
    });
    expect(rewrites).toBe(1);
    expect(res).toMatchObject({ outcome: "passed", rewrites: 1, draft: good });
  });

  it("SPIKES the story when the sentence is still unsupported after the one rewrite", async () => {
    const llm = editor(["walked out", "staged a protest"]);
    let rewrites = 0;
    const stillBad: Draft = { ...bad, body: "The state assembly passed the heat-action bill on Tuesday. Opposition members staged a protest." };
    const res = await copyDesk(bad, {
      check: (d) => checkDraft(llm, new Meter(), facts, d),
      rewrite: async () => { rewrites++; return stillBad; },
    });
    expect(rewrites).toBe(1); // exactly one attempt, never a second
    expect(res.outcome).toBe("spiked");
    if (res.outcome === "spiked") expect(res.problems[0].sentence).toBe("Opposition members staged a protest.");
  });

  it("checks the headline too", async () => {
    const problems = await checkDraft(editor(["Landmark"]), new Meter(), facts, { ...good, headline: "Landmark heat bill passes" });
    expect(problems.map((p) => p.sentence)).toEqual(["Landmark heat bill passes"]);
  });

  it("does not accept 'supported' without a fact from the sheet to back it", async () => {
    const llm = scriptedLlm((_s, user) => ({
      sentences: [...user.matchAll(/^S(\d+)/gm)].map((m) => ({ i: Number(m[1]), supported: true, facts: ["F99"], problem: "" })),
    }));
    const problems = await checkDraft(llm, new Meter(), facts, good);
    expect(problems).toHaveLength(3);
  });

  it("fails the step (rather than passing the copy) when the checker's output stays invalid after two retries", async () => {
    const llm = scriptedLlm(() => "I think it looks fine!");
    await expect(checkDraft(llm, new Meter(), facts, good)).rejects.toBeInstanceOf(LlmStepError);
    expect(llm.calls).toBe(3);
  });

  it("fails the step when the checker skips a sentence", async () => {
    const llm = scriptedLlm(() => ({ sentences: [{ i: 0, supported: true, facts: ["F1"], problem: "" }] }));
    await expect(checkDraft(llm, new Meter(), facts, good)).rejects.toBeInstanceOf(LlmStepError);
  });
});
