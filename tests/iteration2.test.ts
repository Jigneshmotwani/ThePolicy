import { beforeEach, describe, expect, it } from "vitest";
import { openDb, type Db } from "@/lib/db";
import { BudgetExceededError, istDayStart, makeBudget, nextIstMidnight, spentToday, withBudget } from "@/lib/budget";
import { Meter, makeLlm } from "@/lib/llm";
import { approveStory, holdStory, retractStory, setPresses, spikeStory, submitLead } from "@/lib/newsroom";
import { getPrintedStories } from "@/lib/stories";
import { buildFactSheet, humaniseNote, sheetProblem } from "@/pipeline/factChecker";
import { isLiveBlog } from "@/pipeline/liveblog";
import { countIndependentOutlets, qualifies, sharedOrigin, slugTokens, type OutletReport } from "@/pipeline/outlets";
import { lengthProblem } from "@/pipeline/rewriteDesk";
import { processSubmission, queuedSubmissions } from "@/pipeline/submissions";
import { makeCtx, sweep } from "@/pipeline/sweep";
import { z } from "zod";
import { scriptedLlm, words } from "./helpers";
import { article, BRIDGE, feedUrl, item, NOW, status, world } from "./world";

let nextId = 1000;
const report = (outletId: string, extra: Partial<OutletReport> = {}): OutletReport => ({
  id: nextId++, outletId, wireAgency: null, fingerprint: null, ...extra,
});
const isContent = (id: string) => ["toi", "ht", "ie"].includes(id);

/* ------------------------------------------------------------------ A3 */

describe("wire copy: the event #17 case", () => {
  // The real reports behind event #17, as stored.
  const hinduPti = report("hindu", {
    wireAgency: "PTI",
    url: "https://www.thehindu.com/sport/p-t-usha-loses-indian-olympic-association-som-elections/article71683043.ece",
    title: "P. T. Usha fails to get elected as SOM; Saina, Anju Bobby George voted in",
  });
  // Bylined "Express News Service", text no longer like the PTI copy, but the slug is the PTI headline.
  const ie = report("ie", {
    url: "https://indianexpress.com/article/sports/pt-usha-fails-elected-som-saina-anju-bobby-george-voted-in-10956793/",
    title: "IOA president PT Usha not selected to General Assembly as Sportsperson of Merit",
  });
  const ht = report("ht", {
    url: "https://www.hindustantimes.com/sports/others/president-pt-usha-loses-som-polls-eroding-re-election-chances-101794243389882.html",
    title: "President PT Usha loses SOM polls, eroding re-election chances",
  });

  it("reads the slug of an article URL", () => {
    expect(slugTokens(ie.url!)).toEqual(["pt", "usha", "fail", "elected", "som", "saina", "anju", "bobby", "george", "voted"]);
  });

  it("counts the Indian Express page as the same source as The Hindu's PTI copy", () => {
    expect(sharedOrigin(ie, hinduPti)).toMatch(/slug/);
    expect(countIndependentOutlets([hinduPti, ie])).toBe(1);
    expect(qualifies([hinduPti, ie], 2, isContent).ok).toBe(false);
  });

  it("leaves a genuinely separate report separate, so the event has two outlets, not three", () => {
    expect(sharedOrigin(ht, hinduPti)).toBeNull();
    expect(sharedOrigin(ht, ie)).toBeNull();
    expect(countIndependentOutlets([hinduPti, ie, ht])).toBe(2);
  });

  it("does not link reports just because their own slugs resemble their own headlines", () => {
    const a = report("toi", { url: "https://toi.example/india/kosi-bridge-opens-to-traffic-after-four-years/articleshow/1.cms", title: "Kosi bridge opens to traffic after four years" });
    const b = report("ht", { url: "https://ht.example/india-news/chief-minister-inaugurates-long-delayed-bridge-over-kosi-101.html", title: "Chief minister inaugurates long-delayed bridge over Kosi" });
    expect(sharedOrigin(a, b)).toBeNull();
  });

  it("does not link independent outlets whose headlines are alike because the same names lead them (event #385)", () => {
    const toi = report("toi", { url: "https://timesofindia.indiatimes.com/entertainment/tamil/movies/news/priya-bhavani-shankar-marries-longtime-boyfriend-rajvel-raj-in-an-intimate-ceremony-wedding-pictures-and-videos-go-viral/articleshow/135734602.cms", title: "Priya Bhavani Shankar marries longtime boyfriend Rajvel Raj in intimate wedding ceremony" });
    const ie2 = report("ie", { url: "https://indianexpress.com/article/entertainment/tamil/priya-bhavani-shankar-marries-longtime-partner-rajvel-raj-in-intimate-ceremony-watch-video-10958911/", title: "Priya Bhavani Shankar marries longtime partner Rajvel Raj in intimate ceremony, watch video" });
    const ht2 = report("ht", { url: "https://www.hindustantimes.com/entertainment/tamil-cinema/priya-bhavani-shankar-marries-boyfriend-rajvel-raj-in-intimate-ceremony-wedding-video-out-101794381807205.html", title: "Priya Bhavani Shankar marries boyfriend Rajvel Raj in intimate ceremony, wedding video out" });
    expect(countIndependentOutlets([toi, ie2, ht2])).toBe(3);
  });

  it("links a page that kept a wire report's headline as its slug and its headline", () => {
    const pti = report("hindu", { wireAgency: "PTI", url: "https://h.example/a/cabinet-approves-rs-62370-crore-fertiliser-subsidy-for-rabi-season/article1.ece", title: "Cabinet approves Rs 62,370 crore fertiliser subsidy for rabi season" });
    const copy = report("ie", { url: "https://indianexpress.com/article/india/cabinet-approves-rs-62370-crore-fertiliser-subsidy-rabi-season-1234567/", title: "Cabinet approves Rs 62,370 crore fertiliser subsidy for rabi season" });
    expect(countIndependentOutlets([pti, copy])).toBe(1);
  });

  it("a claim backed only by the PTI copy and the slug-matched page is not corroborated", async () => {
    const llm = scriptedLlm(() => ({
      conflicts: [],
      facts: [
        { text: "PT Usha lost the election.", support: ["R1.1", "R2.1", "R3.1"], role: "core" },
        { text: "The election was controversial.", support: ["R1.2", "R2.2"], role: "supporting" },
      ],
    }));
    const sheet = await buildFactSheet(llm, new Meter(), [
      { report: hinduPti, claims: ["Usha lost.", "The election was controversial."] },
      { report: ie, claims: ["Usha lost.", "It was controversial."] },
      { report: ht, claims: ["Usha lost."] },
    ], 2);
    expect(sheet.facts.map((f) => f.text)).toEqual(["PT Usha lost the election."]);
  });
});

describe("reports whose provenance we cannot see (feed only, no byline)", () => {
  const unseenHindu = report("hindu", { unseen: true, title: "Cabinet approves fertiliser subsidy for rabi season" });
  it("are never counted as independent of wire copy in the same event", () => {
    expect(countIndependentOutlets([unseenHindu, report("ht", { wireAgency: "PTI" })])).toBe(1);
  });
  it("do count beside an outlet's own reporting", () => {
    expect(countIndependentOutlets([unseenHindu, report("ht")])).toBe(2);
  });
  it("are one source when two of them carry the same headline", () => {
    const ndtv = report("ndtv", { unseen: true, title: "Cabinet approves fertiliser subsidy for the rabi season" });
    expect(countIndependentOutlets([unseenHindu, ndtv])).toBe(1);
  });
});

/* ------------------------------------------------------------------ A4 */

describe("live blogs", () => {
  it("recognises the two live-score pages behind event #53", () => {
    expect(isLiveBlog("https://www.hindustantimes.com/cricket/ind-vs-nz-live-score-3rd-odi-india-vs-new-zealand-updates-latest-scorecard-hamilton-10-november-101794271476050.html", "IND vs NZ, 3rd ODI: Rain washes out Hamilton game without a single ball being bowled")).toBe(true);
    expect(isLiveBlog("https://indianexpress.com/article/sports/cricket/india-vs-new-zealand-3rd-odi-match-live-cricket-score-ind-vs-nz-rohit-sharma-virat-kohli-mitchell-santner-hamilton-10956920/", "India vs New Zealand 3rd ODI: Match called off in Hamilton")).toBe(true);
  });
  it("recognises live pages by title and path", () => {
    expect(isLiveBlog("https://x.example/a/b-123", "Bihar election results LIVE: Counting under way")).toBe(true);
    expect(isLiveBlog("https://x.example/a/b-123", "Parliament winter session Live Updates: Opposition walks out")).toBe(true);
    expect(isLiveBlog("https://x.example/live-blog/budget-2026", "Budget 2026")).toBe(true);
    expect(isLiveBlog("https://x.example/sport/ind-vs-nz-highlights-3rd-odi", "IND vs NZ Highlights: Rain wins")).toBe(true);
  });
  it("leaves ordinary reports alone", () => {
    expect(isLiveBlog("https://www.thehindu.com/sport/cricket/india-vs-new-zealand-third-odi-in-hamilton-on-november-10-2026/article71684940.ece", "Rain plays spoilsport as India vs New Zealand third ODI called off")).toBe(false);
    expect(isLiveBlog("https://x.example/india/couple-in-live-in-relationship-moves-court-123", "Couple in live-in relationship moves court")).toBe(false);
    expect(isLiveBlog("https://x.example/world/olive-oil-prices-rise-123", "Olive oil prices rise")).toBe(false);
    expect(isLiveBlog("https://x.example/business/company-goes-live-with-new-plant-9", "Company goes live with new plant")).toBe(false);
  });

  it("a live page is never grouped, read for claims, counted as an outlet or shown as a source", async () => {
    const db = openDb(":memory:");
    const liveUrl = article("https://ht.example/cricket/kosi-bridge-opening-live-updates-ceremony-101", "Staff B", BRIDGE);
    const feeds = {
      [feedUrl("toi")]: [item(article("https://toi.example/bridge", "Staff A", BRIDGE), "Kosi bridge opens")],
      [feedUrl("ht")]: [item(liveUrl, "Kosi bridge opening Live Updates: CM arrives")],
    };
    const w = world(feeds);
    await sweep({ db, ...w });
    // Only the TOI report made an event; it waits on one outlet.
    expect(status(db)).toMatchObject([{ status: "waiting" }]);
    expect(db.prepare("SELECT sort_status, discard_note FROM reports WHERE url = ?").get(liveUrl)).toMatchObject({ sort_status: "discarded", discard_note: "live blog or live-score page" });
    expect(db.prepare("SELECT COUNT(*) n FROM report_claims").get()).toEqual({ n: 0 });
    expect(getPrintedStories(db)).toEqual([]);
  });

  it("a live page already attached to a printed story is dropped from its source links", async () => {
    const db = openDb(":memory:");
    const feeds = {
      [feedUrl("toi")]: [item(article("https://toi.example/bridge", "Staff A", BRIDGE), "Kosi bridge opens")],
      [feedUrl("ht")]: [item(article("https://ht.example/bridge-x", "Staff B", BRIDGE), "Kosi bridge inaugurated")],
      [feedUrl("nie")]: [item(article("https://nie.example/bridge-y", "Staff C", BRIDGE), "Kosi bridge opened")],
    };
    await sweep({ db, ...world(feeds) });
    expect(getPrintedStories(db)[0].sources.map((s) => s.outletId).sort()).toEqual(["ht", "nie", "toi"]);
    // Pretend one of them was a live page all along (as with stories printed before this rule existed).
    db.prepare("UPDATE reports SET url = 'https://nie.example/sport/match-live-score-updates-1' WHERE outlet_id = 'nie'").run();
    expect(getPrintedStories(db)[0].sources.map((s) => s.outletId).sort()).toEqual(["ht", "toi"]);
  });
});

/* ------------------------------------------------------------------ A5 */

describe("fact sheet roles and the core-claim rule", () => {
  const toi = report("toi");
  const ht = report("ht");

  it("needs enough claims and at least one core claim", () => {
    expect(sheetProblem([{ role: "core" }, { role: "supporting" }], 3)).toMatch(/only 2 claims/);
    expect(sheetProblem([{ role: "supporting" }, { role: "supporting" }, { role: "background" }], 3)).toMatch(/no corroborated core claim/);
    expect(sheetProblem([{ role: "core" }, { role: "supporting" }, { role: "background" }], 3)).toBeNull();
  });

  it("keeps each fact's role and drops claims about a different event", async () => {
    const llm = scriptedLlm(() => ({
      conflicts: [],
      facts: [
        { text: "The trailer of Maatrubhumi was released.", support: ["R1.1", "R2.1"], role: "core" },
        { text: "The film is due in cinemas on December 4.", support: ["R1.2", "R2.2"], role: "supporting" },
        { text: "The film is directed by Apoorva Lakhia.", support: ["R1.3", "R2.3"], role: "background" },
        { text: "Vamshi Paidipally is set to work with Salman Khan on another film.", support: ["R1.4", "R2.4"], role: "other_event" },
      ],
    }));
    const four = ["a.", "b.", "c.", "d."];
    const sheet = await buildFactSheet(llm, new Meter(), [{ report: toi, claims: four }, { report: ht, claims: four }], 2, "Maatrubhumi trailer released");
    expect(sheet.facts.map((f) => f.role)).toEqual(["core", "supporting", "background"]);
    expect(sheet.facts.map((f) => f.text).join(" ")).not.toMatch(/Vamshi/);
    expect(sheet.offEvent).toBe(1);
  });

  it("a story whose outlets agree only on side details waits; it is not written", async () => {
    const db = openDb(":memory:");
    const feeds = {
      [feedUrl("toi")]: [item(article("https://toi.example/bridge", "Staff A", BRIDGE), "Kosi bridge opens")],
      [feedUrl("ht")]: [item(article("https://ht.example/bridge-x", "Staff B", BRIDGE), "Kosi bridge inaugurated")],
    };
    await sweep({ db, ...world(feeds, { roles: ["supporting", "background", "supporting"] }) });
    expect(status(db)).toMatchObject([{ status: "waiting" }]);
    expect(status(db)[0].status_note).toMatch(/no corroborated core claim/);
    expect(db.prepare("SELECT COUNT(*) n FROM steps WHERE agent = 'Rewrite Desk'").get()).toEqual({ n: 0 });
  });

  it("stores the role with each claim", async () => {
    const db = openDb(":memory:");
    const feeds = {
      [feedUrl("toi")]: [item(article("https://toi.example/bridge", "Staff A", BRIDGE), "Kosi bridge opens")],
      [feedUrl("ht")]: [item(article("https://ht.example/bridge-x", "Staff B", BRIDGE), "Kosi bridge inaugurated")],
    };
    await sweep({ db, ...world(feeds, { roles: ["core", "supporting", "background"] }) });
    const roles = (db.prepare("SELECT role FROM fact_claims WHERE status = 'corroborated' ORDER BY id").all() as { role: string }[]).map((r) => r.role);
    expect(roles).toEqual(["core", "supporting", "background"]);
  });
});

describe("copy shape", () => {
  const ok = { headline: "Kosi bridge opens to traffic", body: `The Kosi bridge opened on Tuesday. Then ${words(21)}. Later ${words(21)}.` };
  it("accepts two to four connected sentences", () => expect(lengthProblem(ok)).toBeNull());
  it("rejects a stub sentence standing on its own", () => {
    expect(lengthProblem({ ...ok, body: `The Kosi bridge opened on Tuesday after years of delay and dispute. A ceremony took place. Then ${words(32)}.` })).toMatch(/stub sentence/);
  });
  it("rejects a list of flat statements", () => {
    const body = Array.from({ length: 6 }, (_, i) => `Fact number ${i} is stated plainly here now.`).join(" ");
    expect(lengthProblem({ ...ok, body })).toMatch(/sentences/);
  });
});

describe("conflict notes", () => {
  it("name outlets, never internal claim ids", () => {
    const name = (i: number) => ["The Hindu", "Hindustan Times", "NDTV", "Times of India"][i - 1];
    const out = humaniseNote("Number of injured personnel: R4.8 states two, while R1.1, R2.1 and R2.3 state three.", name);
    expect(out).toBe("Number of injured personnel: Times of India states two, while The Hindu, Hindustan Times state three.");
    expect(humaniseNote("Nature of injuries: R2.7-2.8 describe arm injuries; R3.3 says legs.", name)).not.toMatch(/R\d/);
  });
});

/* ------------------------------------------------------------------ A7 */

describe("daily spend cap", () => {
  let db: Db;
  beforeEach(() => {
    db = openDb(":memory:");
  });
  const spend = (usd: number, at: string) =>
    db.prepare("INSERT INTO steps (agent, status, started_at, ended_at, note, cost_usd) VALUES ('Fact Checker', 'ok', ?, ?, 'x', ?)").run(at, at, usd);

  it("counts the day from midnight to midnight IST", () => {
    // 12 Nov 2026 01:00 IST is 11 Nov 19:30 UTC.
    expect(istDayStart(new Date("2026-11-11T19:30:00Z")).toISOString()).toBe("2026-11-11T18:30:00.000Z");
    expect(istDayStart(new Date("2026-11-11T18:29:59Z")).toISOString()).toBe("2026-11-10T18:30:00.000Z");
    expect(nextIstMidnight(new Date("2026-11-11T19:30:00Z")).toISOString()).toBe("2026-11-12T18:30:00.000Z");
    spend(4, "2026-11-11T18:00:00.000Z"); // yesterday, IST
    spend(1.5, "2026-11-11T18:45:00.000Z"); // today, IST
    expect(spentToday(db, new Date("2026-11-11T19:30:00Z"))).toBe(1.5);
  });

  it("refuses model calls once the cap is reached, and counts what each call cost", async () => {
    const priced = makeLlm(async () => ({ text: '{"ok":true}', model: "m", promptTokens: 1_000_000, completionTokens: 0 }), () => ({ inputPer1m: 2, outputPer1m: 0 }));
    const budget = makeBudget(db, () => NOW, 5);
    const llm = withBudget(priced, budget);
    const call = () => llm.json({ tier: "fast", system: "s", user: "u", schema: z.object({ ok: z.boolean() }), meter: new Meter() });
    await call(); // $2
    await call(); // $4
    await call(); // $6: allowed to start because $4 < $5
    expect(budget.spent()).toBe(6);
    await expect(call()).rejects.toBeInstanceOf(BudgetExceededError);
    expect(budget.spent()).toBe(6);
  });

  it("starts again on the next IST day", async () => {
    let now = new Date("2026-11-11T18:00:00Z");
    spend(5, "2026-11-11T17:00:00.000Z");
    const budget = makeBudget(db, () => now, 5);
    expect(budget.exhausted()).toBe(true);
    now = new Date("2026-11-11T18:31:00Z"); // 00:01 IST next day
    expect(budget.exhausted()).toBe(false);
  });

  it("a sweep over the cap still stores reports but makes no model calls and prints nothing", async () => {
    spend(5, NOW.toISOString());
    const feeds = {
      [feedUrl("toi")]: [item(article("https://toi.example/bridge", "Staff A", BRIDGE), "Kosi bridge opens")],
      [feedUrl("ht")]: [item(article("https://ht.example/bridge-x", "Staff B", BRIDGE), "Kosi bridge inaugurated")],
    };
    const w = world(feeds);
    const summary = await sweep({ db, ...w });
    expect(w.llm.calls).toBe(0);
    expect(summary).toMatchObject({ newReports: 2, printed: 0, llmCalls: 0, budgetStopped: true });
    const skipped = db.prepare("SELECT status, note FROM steps WHERE agent = 'Desk Sorter'").get() as { status: string; note: string };
    expect(skipped.status).toBe("skipped");
    expect(skipped.note).toMatch(/daily budget reached/);
    // Next day: the same reports go through.
    await sweep({ db, ...w, now: () => new Date(NOW.getTime() + 24 * 3600_000) });
    expect(status(db)).toMatchObject([{ status: "printed" }]);
  });

  it("a story caught mid-way by the cap goes back in the queue unharmed, not spiked", async () => {
    const feeds = {
      [feedUrl("toi")]: [item(article("https://toi.example/bridge", "Staff A", BRIDGE), "Kosi bridge opens")],
      [feedUrl("ht")]: [item(article("https://ht.example/bridge-x", "Staff B", BRIDGE), "Kosi bridge inaugurated")],
    };
    const w = world(feeds);
    const budget = makeBudget(db, () => NOW, 5);
    // Let sorting through, then run out as the Fact Checker starts.
    const llm = { json: async (req: Parameters<typeof w.llm.json>[0]) => { if (req.tier === "strong") budget.add(10); return w.llm.json(req as never); } };
    const summary = await sweep({ db, ...w, llm: llm as never, budget });
    expect(summary).toMatchObject({ printed: 0, failed: 0, budgetStopped: true });
    expect(db.prepare("SELECT status, status_reason, fail_count FROM events").get()).toMatchObject({ status: "waiting", status_reason: "budget", fail_count: 0 });
  });
});

/* ------------------------------------------------------- newsroom actions */

describe("retraction", () => {
  it("takes a printed story out of the feed at once and records why", async () => {
    const db = openDb(":memory:");
    const feeds = {
      [feedUrl("toi")]: [item(article("https://toi.example/bridge", "Staff A", BRIDGE), "Kosi bridge opens")],
      [feedUrl("ht")]: [item(article("https://ht.example/bridge-x", "Staff B", BRIDGE), "Kosi bridge inaugurated")],
    };
    await sweep({ db, ...world(feeds) });
    const [story] = getPrintedStories(db);
    expect(story).toBeTruthy();

    expect(retractStory(db, story.id, "  ").ok).toBe(false); // a reason is required
    expect(getPrintedStories(db)).toHaveLength(1);

    expect(retractStory(db, story.id, "Second source withdrew its report").ok).toBe(true);
    expect(getPrintedStories(db)).toEqual([]);
    expect(db.prepare("SELECT status, status_note FROM events WHERE id = ?").get(story.id)).toMatchObject({ status: "retracted", status_note: "Retracted: Second source withdrew its report" });
    const log = db.prepare("SELECT action, detail, at FROM admin_actions WHERE event_id = ?").get(story.id) as { action: string; detail: string; at: string };
    expect(log).toMatchObject({ action: "retract", detail: "Second source withdrew its report" });
    expect(Date.parse(log.at)).not.toBeNaN();
    expect(retractStory(db, story.id, "again").ok).toBe(false); // only printed stories
  });
});

describe("an editor cannot print a single-source story", () => {
  let db: Db;
  beforeEach(() => {
    db = openDb(":memory:");
  });
  const oneOutlet = { [feedUrl("toi")]: [item(article("https://timesofindia.indiatimes.com/india/kosi-bridge/articleshow/1.cms", "Staff A", BRIDGE), "Kosi bridge opens")] };
  const twoOutlets = { ...oneOutlet, [feedUrl("ht")]: [item(article("https://www.hindustantimes.com/india-news/kosi-bridge-inaugurated-101.html", "Staff B", BRIDGE), "Kosi bridge inaugurated")] };
  const run = async (w: ReturnType<typeof world>) => {
    for (const sub of queuedSubmissions({ db })) await processSubmission(makeCtx({ db, ...w }, null), sub);
  };

  it("a submitted link that only one outlet reports waits for a second outlet", async () => {
    const w = world(oneOutlet);
    await sweep({ db, ...w });
    expect(submitLead(db, "https://timesofindia.indiatimes.com/india/kosi-bridge/articleshow/1.cms", "india").ok).toBe(true);
    await run(w);
    const sub = db.prepare("SELECT status, outcome, event_id FROM submissions").get() as { status: string; outcome: string; event_id: number };
    expect(sub).toMatchObject({ status: "done", outcome: "matched" });
    expect(db.prepare("SELECT status, priority, status_note FROM events WHERE id = ?").get(sub.event_id)).toMatchObject({ status: "waiting", priority: 1 });
    expect(status(db)[0].status_note).toMatch(/1 independent outlet/);
    expect(getPrintedStories(db)).toEqual([]);
    expect(db.prepare("SELECT COUNT(*) n FROM angles").get()).toEqual({ n: 0 });
  });

  it("the same submission prints once a second outlet has the story, through the usual checks", async () => {
    const w = world(twoOutlets);
    await sweep({ db, ...w, now: () => NOW });
    db.exec("UPDATE events SET status = 'waiting', facts_stale = 0, headline = NULL; DELETE FROM angles; DELETE FROM steps;");
    submitLead(db, "https://www.hindustantimes.com/india-news/kosi-bridge-inaugurated-101.html", "india");
    await run(w);
    expect(status(db)).toMatchObject([{ status: "printed", outlet_count: 2 }]);
    const agents = (db.prepare("SELECT agent FROM steps WHERE event_id IS NOT NULL ORDER BY id").all() as { agent: string }[]).map((s) => s.agent);
    expect(agents).toEqual(["Fact Checker", "Rewrite Desk", "Copy Editor", "Picture Desk", "Press Room"]);
  });

  it("a link to a page we have not seen is fetched, matched against stored reports and joins their event", async () => {
    const w = world(oneOutlet);
    await sweep({ db, ...w });
    const url = article("https://www.hindustantimes.com/india-news/new-kosi-bridge-thrown-open-102.html", "Staff B", BRIDGE);
    (await import("./world")).articles[url].title = "New Kosi bridge thrown open";
    submitLead(db, url, "india");
    await run(w);
    expect(db.prepare("SELECT COUNT(*) n FROM events").get()).toEqual({ n: 1 });
    expect(status(db)).toMatchObject([{ status: "printed", outlet_count: 2 }]);
  });

  it("a topic is matched against recent reports; one that matches nothing says so", async () => {
    const w = world(oneOutlet);
    await sweep({ db, ...w });
    submitLead(db, "Kosi bridge opening", "india");
    submitLead(db, "Lunar eclipse over Ladakh", "india");
    await run(w);
    const subs = db.prepare("SELECT input, outcome, note, event_id FROM submissions ORDER BY id").all() as { input: string; outcome: string; note: string; event_id: number | null }[];
    expect(subs[0]).toMatchObject({ outcome: "matched", event_id: 1 });
    expect(subs[1].outcome).toBe("no_match");
    expect(subs[1].note).toMatch(/Matched nothing/);
    expect(getPrintedStories(db)).toEqual([]); // matched, but still one outlet
  });

  it("links from outside our outlets, and live pages, are refused", async () => {
    const w = world(oneOutlet);
    submitLead(db, "https://some-blog.example/kosi-bridge", "india");
    submitLead(db, "https://www.hindustantimes.com/cricket/ind-vs-nz-live-score-3rd-odi-101.html", "sport");
    await run(w);
    const subs = db.prepare("SELECT outcome, note FROM submissions ORDER BY id").all() as { outcome: string; note: string }[];
    expect(subs.map((s) => s.outcome)).toEqual(["rejected", "rejected"]);
    expect(subs[0].note).toMatch(/not one of the outlets we read/);
    expect(subs[1].note).toMatch(/live/);
    expect(db.prepare("SELECT COUNT(*) n FROM events").get()).toEqual({ n: 0 });
  });

  it("for a feed-only outlet the page is never fetched", async () => {
    const w = world(oneOutlet);
    let pageFetches = 0;
    submitLead(db, "https://indianexpress.com/article/india/kosi-bridge-opens-123/", "india");
    for (const sub of queuedSubmissions({ db })) {
      await processSubmission(makeCtx({ db, ...w, fetchPage: async () => (pageFetches++, null) }, null), sub);
    }
    expect(pageFetches).toBe(0);
    expect((db.prepare("SELECT outcome, note FROM submissions").get() as { outcome: string; note: string })).toMatchObject({ outcome: "no_match" });
  });

  it("approving a held single-source story is refused; holding, releasing and spiking are recorded", async () => {
    const w = world(oneOutlet);
    await sweep({ db, ...w });
    const id = 1;
    expect(holdStory(db, id).ok).toBe(true);
    // Force the worst case: a held story that somehow has finished copy but one outlet behind it.
    db.prepare("UPDATE events SET headline = 'Kosi bridge opens' WHERE id = ?").run(id);
    db.prepare("INSERT INTO angles (event_id, body, word_count, created_at) VALUES (?, 'Body.', 1, ?)").run(id, NOW.toISOString());
    const fc = Number(db.prepare("INSERT INTO fact_claims (event_id, text, status, role, created_at) VALUES (?, 'The bridge opened.', 'corroborated', 'core', ?)").run(id, NOW.toISOString()).lastInsertRowid);
    db.prepare("INSERT INTO fact_claim_support (fact_claim_id, report_id) VALUES (?, 1)").run(fc);
    const res = approveStory(db, id);
    expect(res.ok).toBe(false);
    expect(res.message).toMatch(/two independent outlets/);
    expect(getPrintedStories(db)).toEqual([]);
    expect(db.prepare("SELECT status FROM events WHERE id = ?").get(id)).toEqual({ status: "held" });

    expect(spikeStory(db, id, "not news").ok).toBe(true);
    const actions = (db.prepare("SELECT action FROM admin_actions ORDER BY id").all() as { action: string }[]).map((a) => a.action);
    expect(actions).toEqual(["hold", "spike"]);
  });

  it("a held, complete, two-outlet story prints on approval, but not while the presses are stopped", async () => {
    db.prepare("UPDATE desk_rules SET rule = 'review' WHERE desk = 'india'").run();
    await sweep({ db, ...world(twoOutlets) });
    expect(status(db)).toMatchObject([{ status: "held" }]);
    setPresses(db, true);
    expect(approveStory(db, 1).ok).toBe(false);
    setPresses(db, false);
    expect(approveStory(db, 1).ok).toBe(true);
    expect(getPrintedStories(db)).toHaveLength(1);
  });

  it("an editor's hold on a story that is on the desks is not overridden by the pipeline", async () => {
    const w = world(twoOutlets);
    const llm = { json: async (req: Parameters<typeof w.llm.json>[0]) => { if (req.system.startsWith("You are the rewrite desk")) holdStory(db, 1); return w.llm.json(req as never); } };
    await sweep({ db, ...w, llm: llm as never });
    expect(db.prepare("SELECT status, status_reason FROM events").get()).toMatchObject({ status: "held", status_reason: "editor_hold" });
    expect(getPrintedStories(db)).toEqual([]);
  });
});
