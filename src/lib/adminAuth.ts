import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { nowIso, type Db } from "./db";
import { env } from "./env";

/**
 * Access to the newsroom console: one password (ADMIN_PASSWORD) and a
 * session cookie. Sessions live in SQLite so that logging out, or clearing
 * the table, ends them. With no ADMIN_PASSWORD set, nobody can log in.
 */

export const COOKIE = "tss_admin";
const SESSION_HOURS = 12;

const sha = (s: string) => createHash("sha256").update(s).digest();

/** Slow down guessing: at most 8 wrong passwords a minute per process. */
const failures: number[] = [];
function throttled(): boolean {
  const cutoff = Date.now() - 60_000;
  while (failures.length && failures[0] < cutoff) failures.shift();
  return failures.length >= 8;
}

export type LoginResult = { ok: true; token: string; maxAge: number } | { ok: false; status: number; message: string };

/** Read at call time, so a changed .env takes effect on restart without stale module state. */
const configuredPassword = () => (process.env.ADMIN_PASSWORD ?? env.adminPassword).trim();

export function login(db: Db, password: unknown, configured = configuredPassword()): LoginResult {
  if (!configured) return { ok: false, status: 503, message: "The console is switched off: set ADMIN_PASSWORD in .env and restart the app." };
  if (throttled()) return { ok: false, status: 429, message: "Too many wrong passwords. Wait a minute and try again." };
  if (typeof password !== "string" || !timingSafeEqual(sha(password), sha(configured))) {
    failures.push(Date.now());
    return { ok: false, status: 401, message: "Wrong password." };
  }
  const token = randomBytes(32).toString("hex");
  const now = new Date();
  db.prepare("DELETE FROM admin_sessions WHERE expires_at < ?").run(now.toISOString());
  db.prepare("INSERT INTO admin_sessions (token_hash, created_at, expires_at) VALUES (?, ?, ?)").run(
    sha(token).toString("hex"), now.toISOString(), new Date(now.getTime() + SESSION_HOURS * 3600_000).toISOString(),
  );
  return { ok: true, token, maxAge: SESSION_HOURS * 3600 };
}

export function tokenFromCookieHeader(header: string | null | undefined): string | null {
  for (const part of (header ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === COOKIE) return v.join("=") || null;
  }
  return null;
}

export function isValidSession(db: Db, token: string | null | undefined): boolean {
  if (!token || !/^[0-9a-f]{64}$/.test(token)) return false;
  const row = db.prepare("SELECT expires_at FROM admin_sessions WHERE token_hash = ?").get(sha(token).toString("hex")) as
    | { expires_at: string }
    | undefined;
  return !!row && row.expires_at > nowIso();
}

export function logout(db: Db, token: string | null | undefined) {
  if (token) db.prepare("DELETE FROM admin_sessions WHERE token_hash = ?").run(sha(token).toString("hex"));
}
