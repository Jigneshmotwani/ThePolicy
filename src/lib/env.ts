import fs from "node:fs";
import path from "node:path";

// Load .env for the worker and scripts (Next.js loads it for the app itself).
const envFile = path.resolve(process.cwd(), ".env");
if (fs.existsSync(envFile)) {
  try {
    process.loadEnvFile(envFile);
  } catch {
    /* unreadable .env: fall back to the real environment */
  }
}

const str = (k: string, d: string) => (process.env[k]?.trim() ? process.env[k]!.trim() : d);
const num = (k: string, d: number) => {
  const v = Number(process.env[k]);
  return Number.isFinite(v) && process.env[k]?.trim() ? v : d;
};

export const env = {
  aiandApiKey: str("AIAND_API_KEY", ""),
  aiandBaseUrl: str("AIAND_BASE_URL", "https://api.aiand.com/v1"),
  modelFast: str("MODEL_FAST", "deepseek-ai/deepseek-v4.1-flash-1017"),
  modelStrong: str("MODEL_STRONG", "deepseek-ai/deepseek-v4-pro"),
  reasoningFast: str("REASONING_FAST", "low"),
  reasoningStrong: str("REASONING_STRONG", "high"),
  sweepMinutes: num("SWEEP_MINUTES", 5),
  minOutlets: num("MIN_OUTLETS", 2),
  waitingTtlHours: num("WAITING_TTL_HOURS", 12),
  minClaims: num("MIN_CLAIMS", 3),
  maxEventsPerSweep: num("MAX_EVENTS_PER_SWEEP", 40),
  userAgent: str("BOT_USER_AGENT", "TheSecondSourceBot/0.1 (news corroboration; local development)"),
  fetchDelayMs: num("FETCH_DELAY_MS", 1000),
  databasePath: str("DATABASE_PATH", "./data/second-source.db"),
};

/** Reports older than this are not grouped into events. */
export const EVENT_WINDOW_HOURS = 48;
