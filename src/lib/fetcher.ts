/**
 * The polite network layer. Every outbound request to a news outlet goes
 * through politeFetch, which
 *   - identifies us honestly (env.userAgent; never a browser string),
 *   - obeys robots.txt (our own group if the site names us, else "*"),
 *   - serialises and spaces requests per host, and caps overall concurrency,
 *   - retries once on a network error / 5xx / 429 and never on a 4xx.
 * A 403 is an answer, not an obstacle: it is returned to the caller as-is.
 */
import { env } from "./env";

export class RobotsDisallowedError extends Error {
  constructor(message = "Disallowed by robots.txt") {
    super(message);
    this.name = "RobotsDisallowedError";
  }
}

export interface FetchResult {
  status: number;
  text: string;
  headers: Headers;
}

export interface PoliteFetchOptions {
  headers?: Record<string, string>;
  timeoutMs?: number;
  maxBytes?: number;
}

const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_MAX_BYTES = 3 * 1024 * 1024;
const ROBOTS_MAX_BYTES = 512 * 1024;
const MAX_IN_FLIGHT = 6;
const MAX_REDIRECTS = 5;
const RETRY_PAUSE_MS = 2_000;
const MAX_CRAWL_DELAY_MS = 10_000;
/** How long a "robots.txt is unavailable (5xx)" verdict is kept before re-checking. */
const ROBOTS_UNAVAILABLE_TTL_MS = 10 * 60_000;
const UA_TOKEN = "thesecondsourcebot";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// robots.txt parsing (pure)
// ---------------------------------------------------------------------------

interface RobotsRule {
  allow: boolean;
  pattern: string;
  re: RegExp;
}

export interface RobotsPolicy {
  isAllowed(path: string): boolean;
  crawlDelayMs: number | null;
}

function ruleRegex(pattern: string): RegExp {
  const anchored = pattern.endsWith("$");
  const body = anchored ? pattern.slice(0, -1) : pattern;
  const src = body
    .split("*")
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp("^" + src + (anchored ? "$" : ""));
}

/**
 * Parse a robots.txt body for one crawler. `uaToken` is our product token;
 * a group applies to us when its User-agent value contains the token
 * (case-insensitive). If no group names us, the "*" group applies.
 * `isAllowed` takes a path with its query string ("/a/b?x=1").
 */
export function parseRobots(txt: string, uaToken: string): RobotsPolicy {
  const token = uaToken.trim().toLowerCase();
  interface Group {
    agents: string[];
    rules: RobotsRule[];
    crawlDelayMs: number | null;
  }
  const groups: Group[] = [];
  let current: Group | null = null;
  let lastWasAgent = false;

  for (const rawLine of txt.replace(/^\uFEFF/, "").split(/\r\n|\r|\n/)) {
    const line = rawLine.replace(/#.*$/, "").trim();
    if (!line) continue;
    const colon = line.indexOf(":");
    if (colon < 0) continue;
    const field = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();

    if (field === "user-agent") {
      if (!current || !lastWasAgent) {
        current = { agents: [], rules: [], crawlDelayMs: null };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    if (field === "allow" || field === "disallow") {
      lastWasAgent = false;
      if (!current) continue; // rule before any User-agent line: ignored
      if (!value) continue; // "Disallow:" (empty) restricts nothing
      const pattern = value.startsWith("/") || value.startsWith("*") ? value : "/" + value;
      current.rules.push({ allow: field === "allow", pattern, re: ruleRegex(pattern) });
      continue;
    }
    if (field === "crawl-delay") {
      lastWasAgent = false;
      const secs = Number(value);
      if (current && Number.isFinite(secs) && secs >= 0) current.crawlDelayMs = Math.round(secs * 1000);
      continue;
    }
    // Sitemap, Host, etc. do not end or alter a group.
  }

  let chosen = token ? groups.filter((g) => g.agents.some((a) => a !== "*" && a.includes(token))) : [];
  if (chosen.length === 0) chosen = groups.filter((g) => g.agents.includes("*"));

  const rules = chosen.flatMap((g) => g.rules);
  const delays = chosen.map((g) => g.crawlDelayMs).filter((d): d is number => d != null);
  const crawlDelayMs = delays.length ? Math.max(...delays) : null;

  return {
    crawlDelayMs,
    isAllowed(path: string): boolean {
      const p = path.startsWith("/") ? path : "/" + path;
      if (p === "/robots.txt") return true;
      let best: RobotsRule | null = null;
      for (const rule of rules) {
        if (!rule.re.test(p)) continue;
        if (
          !best ||
          rule.pattern.length > best.pattern.length ||
          (rule.pattern.length === best.pattern.length && rule.allow && !best.allow)
        ) {
          best = rule;
        }
      }
      return best ? best.allow : true;
    },
  };
}

const ALLOW_ALL: RobotsPolicy = { isAllowed: () => true, crawlDelayMs: null };
const DENY_ALL: RobotsPolicy = { isAllowed: (p) => p === "/robots.txt", crawlDelayMs: null };

// ---------------------------------------------------------------------------
// Transport: global fetch, or undici through the environment's proxy
// ---------------------------------------------------------------------------

type FetchFn = (url: string, init: Record<string, unknown>) => Promise<Response>;

let transportPromise: Promise<FetchFn> | undefined;

/**
 * Node's built-in fetch ignores HTTPS_PROXY unless the process was started
 * with NODE_USE_ENV_PROXY=1. When a proxy is configured and Node is not
 * already honouring it, route through undici's EnvHttpProxyAgent (which also
 * respects NO_PROXY). With no proxy variables set this is plain global fetch.
 * TLS verification is never touched.
 */
function getTransport(): Promise<FetchFn> {
  transportPromise ??= (async (): Promise<FetchFn> => {
    const plain: FetchFn = (url, init) => fetch(url, init as RequestInit);
    const proxy =
      process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy;
    const nodeHandlesIt = ["1", "true"].includes((process.env.NODE_USE_ENV_PROXY ?? "").toLowerCase());
    if (!proxy || nodeHandlesIt) return plain;
    try {
      const undici = await import("undici");
      const dispatcher = new undici.EnvHttpProxyAgent();
      // undici's own fetch is used with its own dispatcher: mixing an npm
      // undici dispatcher into Node's bundled fetch is not version-safe.
      return (url, init) =>
        undici.fetch(url, { ...(init as object), dispatcher } as never) as unknown as Promise<Response>;
    } catch {
      return plain; // undici not installed: nothing more we can do without a dependency
    }
  })();
  return transportPromise;
}

// ---------------------------------------------------------------------------
// Scheduling: per-host queue + global cap
// ---------------------------------------------------------------------------

interface HostState {
  tail: Promise<unknown>;
  /** When the last request to this host finished. */
  lastDoneAt: number;
  delayMs: number;
  robots?: RobotsPolicy;
  robotsExpiresAt?: number;
  robotsLoading?: Promise<RobotsPolicy>;
}

const hosts = new Map<string, HostState>();

function hostState(origin: string): HostState {
  let h = hosts.get(origin);
  if (!h) {
    h = { tail: Promise.resolve(), lastDoneAt: 0, delayMs: env.fetchDelayMs };
    hosts.set(origin, h);
  }
  return h;
}

let inFlight = 0;
const waiters: (() => void)[] = [];

async function acquireGlobal(): Promise<void> {
  if (inFlight < MAX_IN_FLIGHT) {
    inFlight++;
    return;
  }
  await new Promise<void>((resolve) => waiters.push(resolve)); // slot is handed over
}

function releaseGlobal(): void {
  const next = waiters.shift();
  if (next) next();
  else inFlight--;
}

/** Run `job` as this host's next request: after the previous one, spaced by the host's delay. */
function enqueue<T>(origin: string, job: () => Promise<T>): Promise<T> {
  const h = hostState(origin);
  const run = h.tail.then(async () => {
    const wait = h.lastDoneAt + Math.max(h.delayMs, env.fetchDelayMs) - Date.now();
    if (h.lastDoneAt && wait > 0) await sleep(wait);
    await acquireGlobal();
    try {
      return await job();
    } finally {
      releaseGlobal();
      h.lastDoneAt = Date.now();
    }
  });
  h.tail = run.catch(() => undefined);
  return run;
}

// ---------------------------------------------------------------------------
// One HTTP exchange (no redirects), with the single retry
// ---------------------------------------------------------------------------

async function readCapped(res: Response, maxBytes: number): Promise<string> {
  const charset = /charset\s*=\s*"?([^";\s]+)/i.exec(res.headers.get("content-type") ?? "")?.[1];
  let decoder: TextDecoder;
  try {
    decoder = new TextDecoder(charset || "utf-8");
  } catch {
    decoder = new TextDecoder("utf-8");
  }
  if (!res.body) return "";
  const reader = res.body.getReader();
  let out = "";
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    const room = maxBytes - received;
    if (value.byteLength >= room) {
      out += decoder.decode(value.subarray(0, room), { stream: true });
      await reader.cancel().catch(() => undefined);
      break;
    }
    received += value.byteLength;
    out += decoder.decode(value, { stream: true });
  }
  return out + decoder.decode();
}

interface RawResult extends FetchResult {
  location: string | null;
}

async function exchangeOnce(
  url: string,
  headers: Record<string, string>,
  timeoutMs: number,
  maxBytes: number,
): Promise<RawResult> {
  const transport = await getTransport();
  const res = await transport(url, {
    method: "GET",
    headers,
    redirect: "manual",
    signal: AbortSignal.timeout(timeoutMs),
  });
  const outHeaders = new Headers();
  res.headers.forEach((value, key) => {
    try {
      outHeaders.append(key, value);
    } catch {
      /* skip a header the runtime refuses */
    }
  });
  const isRedirect = res.status >= 300 && res.status < 400 && res.status !== 304;
  const location = isRedirect ? res.headers.get("location") : null;
  let text = "";
  if (location) await res.body?.cancel().catch(() => undefined);
  else text = await readCapped(res, maxBytes);
  return { status: res.status, text, headers: outHeaders, location };
}

async function exchange(
  url: string,
  headers: Record<string, string>,
  timeoutMs: number,
  maxBytes: number,
): Promise<RawResult> {
  const retryable = (status: number) => status >= 500 || status === 429;
  try {
    const first = await exchangeOnce(url, headers, timeoutMs, maxBytes);
    if (!retryable(first.status)) return first;
  } catch {
    /* network error or timeout: fall through to the one retry */
  }
  await sleep(RETRY_PAUSE_MS);
  return exchangeOnce(url, headers, timeoutMs, maxBytes);
}

function baseHeaders(): Record<string, string> {
  return {
    "User-Agent": env.userAgent,
    Accept:
      "text/html,application/xhtml+xml,application/rss+xml,application/atom+xml,application/xml;q=0.9,text/xml;q=0.9,*/*;q=0.5",
    "Accept-Language": "en-IN,en;q=0.9",
  };
}

// ---------------------------------------------------------------------------
// robots.txt per host
// ---------------------------------------------------------------------------

async function loadRobots(origin: string): Promise<RobotsPolicy> {
  const h = hostState(origin);
  if (h.robots && (h.robotsExpiresAt == null || h.robotsExpiresAt > Date.now())) return h.robots;
  h.robotsLoading ??= enqueue(origin, async () => {
    let policy = ALLOW_ALL;
    let expiresAt: number | undefined;
    try {
      const headers = { ...baseHeaders(), Accept: "text/plain,*/*;q=0.5" };
      let url = origin + "/robots.txt";
      let res = await exchange(url, headers, DEFAULT_TIMEOUT_MS, ROBOTS_MAX_BYTES);
      for (let hop = 0; res.location && hop < MAX_REDIRECTS; hop++) {
        url = new URL(res.location, url).toString();
        if (!/^https?:/i.test(url)) break;
        res = await exchange(url, headers, DEFAULT_TIMEOUT_MS, ROBOTS_MAX_BYTES);
      }
      if (res.status >= 200 && res.status < 300) {
        policy = parseRobots(res.text, UA_TOKEN);
      } else if (res.status >= 500) {
        // RFC 9309: robots.txt unreachable because of a server error means
        // "assume disallowed". Kept only briefly, then asked again.
        policy = DENY_ALL;
        expiresAt = Date.now() + ROBOTS_UNAVAILABLE_TTL_MS;
      }
      // 3xx that never resolved / 4xx: no robots.txt, everything allowed.
    } catch {
      policy = ALLOW_ALL; // network failure fetching robots.txt: allowed
    }
    h.robots = policy;
    h.robotsExpiresAt = expiresAt;
    if (policy.crawlDelayMs != null && policy.crawlDelayMs > h.delayMs) {
      h.delayMs = Math.min(policy.crawlDelayMs, MAX_CRAWL_DELAY_MS);
    }
    return policy;
  }).finally(() => {
    h.robotsLoading = undefined;
  });
  return h.robotsLoading;
}

// ---------------------------------------------------------------------------
// politeFetch
// ---------------------------------------------------------------------------

export async function politeFetch(url: string, opts: PoliteFetchOptions = {}): Promise<FetchResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  // Callers may add headers (validators, Accept) but never change who we say we are.
  const extra = Object.fromEntries(
    Object.entries(opts.headers ?? {}).filter(([k]) => k.toLowerCase() !== "user-agent"),
  );
  const headers = { ...baseHeaders(), ...extra };

  let current = new URL(url);
  for (let hop = 0; ; hop++) {
    if (current.protocol !== "https:" && current.protocol !== "http:") {
      throw new Error(`Unsupported URL scheme: ${current.protocol}`);
    }
    current.hash = "";
    const origin = current.origin;
    const robots = await loadRobots(origin);
    if (!robots.isAllowed(current.pathname + current.search)) {
      throw new RobotsDisallowedError(`robots.txt disallows ${current.toString()}`);
    }
    const target = current.toString();
    const res = await enqueue(origin, () => exchange(target, headers, timeoutMs, maxBytes));
    if (!res.location) return { status: res.status, text: res.text, headers: res.headers };
    if (hop >= MAX_REDIRECTS) throw new Error(`Too many redirects fetching ${url}`);
    // Each redirect hop is checked against its own host's robots.txt and queue.
    current = new URL(res.location, current);
  }
}
