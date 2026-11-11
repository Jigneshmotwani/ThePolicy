import { listModels } from "../src/lib/llm";
import { env } from "../src/lib/env";

async function main() {
const models = await listModels();
console.log("Models this key can use (USD per 1M tokens in / out):\n");
for (const m of models.values()) {
  const tag = m.id.toLowerCase() === env.modelFast.toLowerCase() ? "  <- MODEL_FAST"
    : m.id.toLowerCase() === env.modelStrong.toLowerCase() ? "  <- MODEL_STRONG" : "";
  console.log(`${m.id.padEnd(44)} ${String(m.inputPer1m).padStart(6)} / ${String(m.outputPer1m).padEnd(6)} efforts: ${m.reasoningEfforts.join(",")}${tag}`);
}
}
main().catch((e) => { console.error(String(e?.message ?? e)); process.exit(1); });
