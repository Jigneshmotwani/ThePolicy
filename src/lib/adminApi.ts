import { COOKIE, isValidSession, login, logout, tokenFromCookieHeader } from "./adminAuth";
import { listStories, overview, runSheet } from "./console";
import type { Db } from "./db";
import { approveStory, holdStory, requestSweep, retractStory, setDeskRule, setPresses, spikeStory, submitLead, type ActionResult } from "./newsroom";

/**
 * Every admin API request comes through handleAdmin. The session check is
 * the first thing it does for every path except the login itself, so there
 * is no route that can be added without it.
 */

/** The routes, for documentation and for the test that proves each one is locked. */
export const ADMIN_ROUTES: { method: "GET" | "POST"; path: string }[] = [
  { method: "GET", path: "overview" },
  { method: "GET", path: "stories" },
  { method: "GET", path: "stories/1" },
  { method: "POST", path: "stories/1/action" },
  { method: "POST", path: "presses" },
  { method: "POST", path: "desks" },
  { method: "POST", path: "submissions" },
  { method: "POST", path: "sweep" },
  { method: "POST", path: "logout" },
];

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...headers } });

const result = (r: ActionResult) => json(r, r.ok ? 200 : 409);

async function body(req: Request): Promise<Record<string, unknown>> {
  try {
    const b = await req.json();
    return b && typeof b === "object" ? (b as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

const cookie = (value: string, maxAge: number, secure: boolean) =>
  `${COOKIE}=${value}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${secure ? "; Secure" : ""}`;

export async function handleAdmin(req: Request, path: string[], db: Db): Promise<Response> {
  const route = path.join("/");
  const method = req.method.toUpperCase();
  const url = new URL(req.url);
  const secure = url.protocol === "https:";

  // Changes must come from our own pages, not from a form on another site.
  if (method !== "GET") {
    const origin = req.headers.get("origin");
    const host = req.headers.get("host") ?? url.host;
    if (origin && new URL(origin).host !== host) return json({ ok: false, message: "Cross-site request refused." }, 403);
  }

  if (route === "login" && method === "POST") {
    const res = login(db, (await body(req)).password);
    if (!res.ok) return json({ ok: false, message: res.message }, res.status);
    return json({ ok: true }, 200, { "Set-Cookie": cookie(res.token, res.maxAge, secure) });
  }

  // ---- everything below needs a session ----
  const token = tokenFromCookieHeader(req.headers.get("cookie"));
  if (!isValidSession(db, token)) return json({ ok: false, message: "Log in to use the console." }, 401);

  if (route === "logout" && method === "POST") {
    logout(db, token);
    return json({ ok: true }, 200, { "Set-Cookie": cookie("", 0, secure) });
  }
  if (route === "overview" && method === "GET") return json(overview(db));
  if (route === "stories" && method === "GET") {
    const q = url.searchParams;
    return json(listStories(db, { filter: q.get("filter") ?? undefined, desk: q.get("desk") ?? undefined, q: q.get("q") ?? undefined, page: Number(q.get("page")) || 1 }));
  }
  if (path[0] === "stories" && /^\d+$/.test(path[1] ?? "")) {
    const id = Number(path[1]);
    if (path.length === 2 && method === "GET") {
      const sheet = runSheet(db, id);
      return sheet ? json(sheet) : json({ ok: false, message: "No such story." }, 404);
    }
    if (path.length === 3 && path[2] === "action" && method === "POST") {
      const b = await body(req);
      const reason = typeof b.reason === "string" ? b.reason.slice(0, 300) : "";
      switch (b.action) {
        case "approve": return result(approveStory(db, id));
        case "hold": return result(holdStory(db, id));
        case "spike": return result(spikeStory(db, id, reason));
        case "retract": return result(retractStory(db, id, reason));
        default: return json({ ok: false, message: "Unknown action." }, 400);
      }
    }
  }
  if (method === "POST") {
    const b = route === "sweep" ? {} : await body(req);
    if (route === "presses") return result(setPresses(db, b.stopped === true));
    if (route === "desks") return result(setDeskRule(db, String(b.desk ?? ""), String(b.rule ?? "")));
    if (route === "submissions") return result(submitLead(db, String(b.input ?? ""), String(b.desk ?? "")));
    if (route === "sweep") return result(requestSweep(db));
  }
  return json({ ok: false, message: "Not found." }, 404);
}
