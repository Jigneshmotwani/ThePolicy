import { beforeEach, describe, expect, it } from "vitest";
import { ADMIN_ROUTES, handleAdmin } from "@/lib/adminApi";
import { COOKIE, isValidSession, login } from "@/lib/adminAuth";
import { listStories, overview, runSheet } from "@/lib/console";
import { openDb, type Db } from "@/lib/db";
import { getPrintedStories } from "@/lib/stories";
import { sweep } from "@/pipeline/sweep";
import { article, BRIDGE, DAM, feedUrl, item, NOW, world } from "./world";

const PASSWORD = "correct horse battery";
process.env.ADMIN_PASSWORD = PASSWORD; // read when the env module first loads

let db: Db;
beforeEach(() => {
  db = openDb(":memory:");
});

const call = (method: string, path: string, opts: { cookie?: string; body?: unknown; origin?: string } = {}) =>
  handleAdmin(
    new Request(`http://localhost:3000/api/admin/${path}`, {
      method,
      headers: { "content-type": "application/json", host: "localhost:3000", ...(opts.cookie ? { cookie: opts.cookie } : {}), ...(opts.origin ? { origin: opts.origin } : {}) },
      body: method === "POST" ? JSON.stringify(opts.body ?? {}) : undefined,
    }),
    path.split("?")[0].split("/"),
    db,
  );

async function session(): Promise<string> {
  const res = await call("POST", "login", { body: { password: PASSWORD } });
  expect(res.status).toBe(200);
  return res.headers.get("set-cookie")!.split(";")[0];
}

describe("admin access", () => {
  it.each(ADMIN_ROUTES)("$method /api/admin/$path refuses a request with no session", async ({ method, path }) => {
    const res = await call(method, path, { body: { action: "retract", reason: "x", stopped: true, desk: "india", rule: "review", input: "x" } });
    expect(res.status).toBe(401);
  });

  it.each(ADMIN_ROUTES)("$method /api/admin/$path refuses a made-up or expired session", async ({ method, path }) => {
    expect((await call(method, path, { cookie: `${COOKIE}=${"a".repeat(64)}` })).status).toBe(401);
    const good = await session();
    db.prepare("UPDATE admin_sessions SET expires_at = '2000-01-01T00:00:00.000Z'").run();
    expect((await call(method, path, { cookie: good })).status).toBe(401);
  });

  it("refuses paths that do not exist without a session too (nothing is reachable unauthenticated)", async () => {
    for (const path of ["nope", "stories/1/unknown", "overview/extra", "settings"]) {
      expect((await call("GET", path)).status).toBe(401);
      expect((await call("POST", path)).status).toBe(401);
    }
  });

  it("an unauthenticated request changes nothing", async () => {
    await call("POST", "presses", { body: { stopped: true } });
    await call("POST", "desks", { body: { desk: "india", rule: "review" } });
    await call("POST", "submissions", { body: { input: "A topic", desk: "india" } });
    await call("POST", "sweep");
    expect(db.prepare("SELECT value FROM settings WHERE key = 'presses_stopped'").get()).toEqual({ value: "0" });
    expect(db.prepare("SELECT rule FROM desk_rules WHERE desk = 'india'").get()).toEqual({ rule: "auto" });
    expect(db.prepare("SELECT COUNT(*) n FROM submissions").get()).toEqual({ n: 0 });
    expect(db.prepare("SELECT COUNT(*) n FROM worker_commands").get()).toEqual({ n: 0 });
    expect(db.prepare("SELECT COUNT(*) n FROM admin_actions").get()).toEqual({ n: 0 });
  });

  it("logs in with the right password only, with an http-only same-site cookie", async () => {
    expect((await call("POST", "login", { body: { password: "wrong" } })).status).toBe(401);
    expect((await call("POST", "login", { body: {} })).status).toBe(401);
    const res = await call("POST", "login", { body: { password: PASSWORD } });
    const set = res.headers.get("set-cookie")!;
    expect(set).toMatch(/HttpOnly/);
    expect(set).toMatch(/SameSite=Strict/);
    expect(await res.text()).not.toContain(set.split(";")[0].split("=")[1]); // the token is not in the body
  });

  it("with no ADMIN_PASSWORD configured nobody gets in", () => {
    expect(login(db, "", "")).toMatchObject({ ok: false, status: 503 });
    expect(login(db, "anything", "")).toMatchObject({ ok: false });
  });

  it("every route works with a session, and logout ends it", async () => {
    const cookie = await session();
    for (const r of ADMIN_ROUTES.filter((x) => x.method === "GET" && x.path !== "stories/1")) {
      expect((await call(r.method, r.path, { cookie })).status).toBe(200);
    }
    expect((await call("GET", "stories/1", { cookie })).status).toBe(404); // authenticated, but there is no story 1
    expect((await call("POST", "logout", { cookie })).status).toBe(200);
    expect(isValidSession(db, cookie.split("=")[1])).toBe(false);
    expect((await call("GET", "overview", { cookie })).status).toBe(401);
  });

  it("refuses a state-changing request sent from another site", async () => {
    const cookie = await session();
    expect((await call("POST", "presses", { cookie, body: { stopped: true }, origin: "https://evil.example" })).status).toBe(403);
    expect((await call("POST", "presses", { cookie, body: { stopped: true }, origin: "http://localhost:3000" })).status).toBe(200);
  });
});

describe("console actions through the API", () => {
  const two = {
    [feedUrl("toi")]: [item(article("https://toi.example/bridge", "Staff A", BRIDGE), "Kosi bridge opens")],
    [feedUrl("ht")]: [item(article("https://ht.example/bridge-x", "Staff B", BRIDGE), "Kosi bridge inaugurated"), item(article("https://ht.example/dam", "Staff C", DAM), "Tehri dam gates opened")],
  };

  it("retracting through the API removes the story from the feed at once and needs a reason", async () => {
    await sweep({ db, ...world(two) });
    const cookie = await session();
    const [story] = getPrintedStories(db);
    expect((await call("POST", `stories/${story.id}/action`, { cookie, body: { action: "retract" } })).status).toBe(409);
    expect(getPrintedStories(db)).toHaveLength(1);
    const res = await call("POST", `stories/${story.id}/action`, { cookie, body: { action: "retract", reason: "Outlet corrected its report" } });
    expect(res.status).toBe(200);
    expect(getPrintedStories(db)).toEqual([]);
    const sheet = runSheet(db, story.id)!;
    expect(sheet.status).toBe("retracted");
    expect(sheet.actions.map((a) => a.action)).toEqual(["retract"]);
  });

  it("a review desk holds; approve prints; stopping the presses and desk rules are recorded with times", async () => {
    const cookie = await session();
    expect((await call("POST", "desks", { cookie, body: { desk: "india", rule: "review" } })).status).toBe(200);
    await sweep({ db, ...world(two) });
    const held = listStories(db, { filter: "held" });
    expect(held.rows).toHaveLength(1);
    expect(held.rows[0]).toMatchObject({ status: "held", stage: 6, agent: "Press Room" });
    expect(listStories(db, {}).rows.map((r) => r.id)).toEqual([held.rows[0].id]); // default view: what is on the desk now

    await call("POST", "presses", { cookie, body: { stopped: true } });
    expect((await call("POST", `stories/${held.rows[0].id}/action`, { cookie, body: { action: "approve" } })).status).toBe(409);
    await call("POST", "presses", { cookie, body: { stopped: false } });
    expect((await call("POST", `stories/${held.rows[0].id}/action`, { cookie, body: { action: "approve" } })).status).toBe(200);
    expect(getPrintedStories(db)).toHaveLength(1);

    const log = db.prepare("SELECT action, at FROM admin_actions ORDER BY id").all() as { action: string; at: string }[];
    expect(log.map((l) => l.action)).toEqual(["desk_rule", "stop_presses", "restart_presses", "approve_print"]);
    expect(log.every((l) => !Number.isNaN(Date.parse(l.at)))).toBe(true);
  });

  it("the single-outlet story cannot be approved into print through the API", async () => {
    await sweep({ db, ...world(two) });
    const cookie = await session();
    const dam = listStories(db, { filter: "waiting" }).rows[0];
    expect(dam.outlets).toBe("1 of 2");
    await call("POST", `stories/${dam.id}/action`, { cookie, body: { action: "hold" } });
    const res = await call("POST", `stories/${dam.id}/action`, { cookie, body: { action: "approve" } });
    expect(res.status).toBe(200); // a hold with nothing written is released, not printed
    expect(db.prepare("SELECT status FROM events WHERE id = ?").get(dam.id)).toEqual({ status: "waiting" });
    expect(getPrintedStories(db).map((s) => s.id)).not.toContain(dam.id);
  });

  it("the run sheet shows the seven steps, the fact sheet with outlets, and the article", async () => {
    await sweep({ db, ...world(two) });
    const [story] = getPrintedStories(db);
    const sheet = runSheet(db, story.id)!;
    expect(sheet.steps.map((s) => s.agent)).toEqual(["Wire Scout", "Desk Sorter", "Fact Checker", "Rewrite Desk", "Copy Editor", "Picture Desk", "Press Room"]);
    expect(sheet.steps.map((s) => s.status)).toEqual(["Done", "Done", "Done", "Done", "Done", "Skipped", "Done"]);
    expect(sheet.steps[2]).toMatchObject({ model: "test-model" });
    expect(sheet.steps[2].promptTokens).toBeGreaterThan(0);
    expect(sheet.facts).toHaveLength(3);
    expect(sheet.facts[0]).toMatchObject({ role: "core", outlets: ["Times of India", "Hindustan Times"] });
    expect(sheet.article).toMatchObject({ headline: "Kosi bridge opens to traffic", printed: true });
    expect(sheet.can).toMatchObject({ retract: true, approve: false, hold: false, spike: false });
  });

  it("overview reports worker health, spend against the cap, and submissions", async () => {
    const cookie = await session();
    await sweep({ db, ...world(two) });
    db.prepare("INSERT INTO settings (key, value) VALUES ('worker_heartbeat', ?)").run(JSON.stringify({ at: NOW.toISOString(), state: "idle", nextSweepAt: NOW.toISOString() }));
    expect(overview(db, new Date(NOW.getTime() + 5000)).health).toMatchObject({ workerAlive: true, cap: 5, budgetPaused: false });
    expect(overview(db, new Date(NOW.getTime() + 60_000)).health.workerAlive).toBe(false);
    db.prepare("INSERT INTO steps (agent, status, started_at, ended_at, note, cost_usd) VALUES ('Fact Checker', 'ok', ?, ?, 'x', 5.5)").run(NOW.toISOString(), NOW.toISOString());
    expect(overview(db, NOW).health).toMatchObject({ budgetPaused: true, spendToday: 5.5 });

    expect((await call("POST", "submissions", { cookie, body: { input: "", desk: "india" } })).status).toBe(409);
    expect((await call("POST", "submissions", { cookie, body: { input: "Kosi bridge", desk: "india" } })).status).toBe(200);
    expect((await call("POST", "sweep", { cookie })).status).toBe(200);
    const o = overview(db, NOW);
    expect(o.submissions[0]).toMatchObject({ state: "queued", input: "Kosi bridge" });
    expect(o.health.sweepRequested).toBe(true);
    expect(o.stats).toMatchObject({ waiting: 1 });
  });

  it("filters, search and paging on the story table", async () => {
    const iso = NOW.toISOString();
    const ins = db.prepare("INSERT INTO events (label, desk, status, created_at, updated_at, expires_at) VALUES (?, ?, 'waiting', ?, ?, ?)");
    for (let i = 0; i < 60; i++) ins.run(`Waiting story ${i} about ${i % 2 ? "cricket" : "markets"}`, i % 2 ? "sport" : "business", iso, iso, iso);
    expect(listStories(db, {}).total).toBe(0); // nothing on the desk
    const w = listStories(db, { filter: "waiting" });
    expect(w).toMatchObject({ total: 60, pages: 3, page: 1 });
    expect(w.rows).toHaveLength(25);
    expect(listStories(db, { filter: "waiting", page: 3 }).rows).toHaveLength(10);
    expect(listStories(db, { filter: "waiting", desk: "sport" }).total).toBe(30);
    expect(listStories(db, { filter: "all", q: "story 59" }).total).toBe(1);
    expect(listStories(db, { filter: "all", q: "100%" }).total).toBe(0);
  });
});
