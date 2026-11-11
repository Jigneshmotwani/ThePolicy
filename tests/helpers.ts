import { makeLlm, type Complete, type Llm } from "@/lib/llm";

/**
 * A scripted model for tests. `script` sees the system prompt and the latest
 * user message and returns the object the "model" should answer with. It goes
 * through the real JSON/zod/retry wrapper, so that code is exercised too.
 */
export function scriptedLlm(script: (system: string, user: string, attempt: number) => unknown): Llm & { calls: number } {
  const counter = { calls: 0 };
  const complete: Complete = async ({ messages }) => {
    counter.calls++;
    const system = messages[0].content;
    const user = messages[1].content;
    const attempt = (messages.length - 2) / 2 + 1;
    const out = script(system, user, attempt);
    return { text: typeof out === "string" ? out : JSON.stringify(out), model: "test-model", promptTokens: 10, completionTokens: 5 };
  };
  const llm = makeLlm(complete);
  return {
    json: llm.json,
    get calls() {
      return counter.calls;
    },
  };
}

/** Exactly n words. */
export const words = (n: number, w = "word") => Array.from({ length: n }, () => w).join(" ");
