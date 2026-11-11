import OpenAI from "openai";
import { z } from "zod";
import { env } from "./env";
import { oneLine } from "./text";

export type Tier = "fast" | "strong";

/** Adds up tokens and cost for one run-log step. */
export class Meter {
  model: string | null = null;
  promptTokens = 0;
  completionTokens = 0;
  calls = 0;
  costUsd = 0;

  add(model: string, prompt: number, completion: number, cost: number) {
    this.model = this.model && this.model !== model ? `${this.model}, ${model}` : model;
    this.promptTokens += prompt;
    this.completionTokens += completion;
    this.calls += 1;
    this.costUsd += cost;
  }
  absorb(o: Meter) {
    if (!o.calls) return;
    if (o.model) this.model = this.model && !this.model.includes(o.model) ? `${this.model}, ${o.model}` : (this.model ?? o.model);
    this.promptTokens += o.promptTokens;
    this.completionTokens += o.completionTokens;
    this.calls += o.calls;
    this.costUsd += o.costUsd;
  }
}

export interface JsonRequest<T> {
  tier: Tier;
  system: string;
  user: string;
  schema: z.ZodType<T>;
  /** Extra rule beyond the schema. Return a complaint to send back, or null if fine. */
  check?: (value: T) => string | null;
  meter: Meter;
  maxTokens?: number;
  /** Plain extraction work: run the tier without extended reasoning (faster, cheaper). */
  light?: boolean;
}

/** The only thing the pipeline stages know about the model. Tests fake this. */
export interface Llm {
  json<T>(req: JsonRequest<T>): Promise<T>;
}

export class LlmStepError extends Error {}

/** Pull the first JSON object out of a model reply (tolerates code fences and chatter). */
export function extractJson(reply: string): unknown {
  const t = reply.replace(/```(?:json)?/gi, "").trim();
  const start = t.indexOf("{");
  const end = t.lastIndexOf("}");
  if (start === -1 || end <= start) throw new Error("no JSON object in reply");
  return JSON.parse(t.slice(start, end + 1));
}

export const MAX_ATTEMPTS = 3; // first try + two retries, then the step fails

export interface RawCompletion {
  text: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
}
export type Complete = (args: {
  tier: Tier;
  messages: { role: "system" | "user" | "assistant"; content: string }[];
  maxTokens: number;
  light?: boolean;
}) => Promise<RawCompletion>;

/**
 * JSON-by-prompt with validation: we do not rely on native structured
 * output. Ask for JSON, validate with zod (plus an optional rule), tell the
 * model what was wrong, retry twice, then fail the step.
 */
export function makeLlm(complete: Complete, priceOf: (model: string) => Price | undefined = () => undefined): Llm {
  return {
    async json<T>(req: JsonRequest<T>): Promise<T> {
      const messages: { role: "system" | "user" | "assistant"; content: string }[] = [
        { role: "system", content: `${req.system}\n\nReply with one JSON object only. No prose, no code fences.` },
        { role: "user", content: req.user },
      ];
      let lastProblem = "";
      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        let reply: RawCompletion;
        try {
          reply = await complete({ tier: req.tier, messages, maxTokens: req.maxTokens ?? 4000, light: req.light });
        } catch (e) {
          lastProblem = `API error: ${oneLine(String((e as Error)?.message ?? e), 160)}`;
          continue;
        }
        const price = priceOf(reply.model);
        req.meter.add(
          reply.model,
          reply.promptTokens,
          reply.completionTokens,
          price ? (reply.promptTokens * price.inputPer1m + reply.completionTokens * price.outputPer1m) / 1e6 : 0,
        );
        let problem: string | null = null;
        try {
          const parsed = req.schema.safeParse(extractJson(reply.text));
          if (!parsed.success) {
            problem = parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).slice(0, 6).join("; ");
          } else {
            problem = req.check ? req.check(parsed.data) : null;
            if (!problem) return parsed.data;
          }
        } catch (e) {
          problem = reply.text.includes("[reply cut off at the output token limit]")
            ? "the reply ran out of room before the JSON was complete; think briefly and answer more concisely"
            : `invalid JSON (${(e as Error).message})`;
        }
        lastProblem = problem ?? "";
        messages.push({ role: "assistant", content: reply.text.slice(0, 6000) });
        messages.push({
          role: "user",
          content: `That reply was rejected: ${problem}. Send the corrected JSON object only.`,
        });
      }
      throw new LlmStepError(`model output still invalid after ${MAX_ATTEMPTS} attempts: ${oneLine(lastProblem, 200)}`);
    },
  };
}

/* ---------- the real ai& client ---------- */

export interface Price {
  inputPer1m: number;
  outputPer1m: number;
}
export interface ModelInfo extends Price {
  id: string;
  reasoningEfforts: string[];
}

let client: OpenAI | undefined;
function getClient(): OpenAI {
  if (!env.aiandApiKey) {
    throw new Error("AIAND_API_KEY is not set. Add it to .env (see .env.example); never commit it.");
  }
  client ??= new OpenAI({ apiKey: env.aiandApiKey, baseURL: env.aiandBaseUrl, maxRetries: 2, timeout: 120_000 });
  return client;
}

let modelCache: Map<string, ModelInfo> | undefined;

/** GET /v1/models: what this key can use, with ai&'s listed prices. */
export async function listModels(): Promise<Map<string, ModelInfo>> {
  if (modelCache) return modelCache;
  const page = await getClient().models.list();
  const out = new Map<string, ModelInfo>();
  for (const m of page.data as unknown as Record<string, unknown>[]) {
    out.set(String(m.id).toLowerCase(), {
      id: String(m.id),
      inputPer1m: Number(m.input_per_1m ?? 0) || 0,
      outputPer1m: Number(m.output_per_1m ?? 0) || 0,
      reasoningEfforts: Array.isArray(m.reasoning_efforts) ? (m.reasoning_efforts as string[]) : [],
    });
  }
  modelCache = out;
  return out;
}

/** Fail early, in plain words, if a configured model is not on the key's list. */
export async function assertModelsAvailable(): Promise<void> {
  const models = await listModels();
  for (const [name, id] of [["MODEL_FAST", env.modelFast], ["MODEL_STRONG", env.modelStrong]] as const) {
    if (!models.has(id.toLowerCase())) {
      throw new Error(
        `${name}=${id} is not available to this key. Available: ${[...models.values()].map((m) => m.id).join(", ")}`,
      );
    }
  }
}

export function realLlm(): Llm {
  const complete: Complete = async ({ tier, messages, maxTokens, light }) => {
    const model = tier === "fast" ? env.modelFast : env.modelStrong;
    const wanted = light ? env.reasoningLight : tier === "fast" ? env.reasoningFast : env.reasoningStrong;
    const info = modelCache?.get(model.toLowerCase());
    const effort = wanted && (!info || info.reasoningEfforts.includes(wanted)) ? wanted : undefined;
    // Streamed: long replies (the strong model thinking through a fact sheet)
    // outlive the gateway's time limit for a single non-streamed response.
    const stream = await getClient().chat.completions.create({
      model,
      messages,
      max_tokens: maxTokens,
      temperature: 0.2,
      stream: true,
      stream_options: { include_usage: true },
      ...(effort ? { reasoning_effort: effort as never } : {}),
    });
    let text = "";
    let served = model;
    let promptTokens = 0;
    let completionTokens = 0;
    let finish = "";
    for await (const chunk of stream) {
      if (chunk.model) served = chunk.model;
      text += chunk.choices?.[0]?.delta?.content ?? "";
      finish = chunk.choices?.[0]?.finish_reason ?? finish;
      if (chunk.usage) {
        promptTokens = chunk.usage.prompt_tokens ?? 0;
        completionTokens = chunk.usage.completion_tokens ?? 0;
      }
    }
    // Cut off by the token limit: say so, so the retry asks for a shorter answer.
    if (finish === "length") text += "\n[reply cut off at the output token limit]";
    return { text, model: served, promptTokens, completionTokens };
  };
  return makeLlm(complete, (m) => modelCache?.get(m.toLowerCase()));
}

/** Run async jobs with a fixed number in flight. */
export async function pool<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i], i);
      }
    }),
  );
  return out;
}
