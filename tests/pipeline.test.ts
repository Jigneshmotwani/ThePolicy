import { beforeEach, describe, expect, it } from "vitest";
import { openDb, setSetting, type Db } from "@/lib/db";
import type { FeedItem } from "@/lib/feeds";
import { sweep } from "@/pipeline/sweep";
import { getPrintedStories } from "@/lib/stories";
import { OUTLETS } from "@config/sources";
import { scriptedLlm, words } from "./helpers";

/**
 * The whole pipeline, end to end, on an in-memory database with scripted
 * feeds, articles and model. No network.
 */

const NOW = new Date("2026-11-11T12:00:00Z");
const feedUrl = (outletId: string) => OUTLETS.find((o) => o.id === outletId)!.feeds[0].url;
const item = (url: string, title: string): FeedItem => ({ url, title, summary: "", publishedAt: "2026-11-11T10:00:00.000Z" });

// Each fake article is a list of plain claims plus filler unique to that page (so the
// texts are not near-identical); the "model" extracts the claims verbatim.
const FILLER = (tag: string) => Array.from({ length: 60 }, (_, i) => `${tag}${i}`).join(" ");
const articles: Record<string, { author: string | null; claims: string[] }> = {};
const article = (url: string, author: string | null, claims: string[]) => { articles[url] = { author, claims }; return url; };

const BRIDGE = ["The Kosi bridge opened on Tuesday.", "The bridge is four kilometres long.", "The chief minister opened the bridge."];
const DAM = ["The Tehri dam gates were opened on Monday.", "Officials said water levels were safe.", "Two villages were alerted."];

function world(feeds: Record<string, FeedItem[]>, opts: { unsupported?: string[] } = {}) {
  const llm = scriptedLlm((system, user) => {
    if (system.startsWith("You sort incoming")) {
      return { items: user.split("\n").map((_, i) => ({ i, desk: "india", kind: "event" })) };
    }
    if (system.startsWith("You decide whether two")) {
      const topics = [...user.matchAll(/Headline: .*?(bridge|dam)/gi)].map((m) => m[1].toLowerCase());
      return { same_event: topics.length === 2 && topics[0] === topics[1] };
    }
    if (system.startsWith("You extract factual claims")) {
      const claims = user.split("\n").slice(3).join(" ").match(/[A-Z][^.]*\./g) ?? [];
      return { claims };
    }
    if (system.startsWith("You build a fact sheet")) {
      const byText = new Map<string, string[]>();
      for (const m of user.matchAll(/^(R\d+\.\d+): (.*)$/gm)) byText.set(m[2], [...(byText.get(m[2]) ?? []), m[1]]);
      return { facts: [...byText].map(([text, support]) => ({ text, support })), conflicts: [] };
    }
    if (system.startsWith("You are the rewrite desk")) {
      return { headline: "Kosi bridge opens to traffic", body: `The Kosi bridge opened on Tuesday. ${words(44)}.` };
    }
    if (system.startsWith("You are the copy editor")) {
      return {
        sentences: [...user.matchAll(/^S(\d+)(?: \(headline\))?: (.*)$/gm)].map((m) => {
          const bad = (opts.unsupported ?? []).some((u) => m[2].includes(u));
          return { i: Number(m[1]), supported: !bad, facts: bad ? [] : ["F1"], problem: bad ? "not on the sheet" : "" };
        }),
      };
    }
    throw new Error(`unscripted prompt: ${system.slice(0, 40)}`);
  });
  return {
    llm,
    now: () => NOW,
    log: () => {},
    fetchFeed: async (url: string) => ({ status: 200, notModified: false, items: feeds[url] ?? [] }),
    fetchArticle: async (url: string) => {
      const a = articles[url];
      return a ? { author: a.author, text: `${a.claims.join(" ")} ${FILLER(url.replace(/[^a-z]/g, ""))}` } : null;
    },
  };
}

const status = (db: Db) =>
  db.prepare("SELECT label, status, status_reason, status_note, outlet_count FROM events ORDER BY id").all() as {
    label: string; status: string; status_reason: string | null; status_note: string; outlet_count: number;
  }[];

let db: Db;
beforeEach(() => {
  db = openDb(":memory:");
});

describe("pipeline end to end", () => {
  it("prints an event two independent outlets report, with a fact sheet and both sources", async () => {
    const feeds = {
      [feedUrl("toi")]: [item(article("https://toi.example/bridge", "Staff A", BRIDGE), "Kosi bridge opens")],
      [feedUrl("ht")]: [item(article("https://ht.example/bridge-x", "Staff B", [...BRIDGE, "It cost 900 crore."]), "New bridge over Kosi inaugurated")],
    };
    const summary = await sweep({ db, ...world(feeds) });
    expect(summary).toMatchObject({ printed: 1, spiked: 0 });
    expect(status(db)).toMatchObject([{ status: "printed", outlet_count: 2 }]);

    const [story] = getPrintedStories(db);
    expect(story.headline).toBe("Kosi bridge opens to traffic");
    expect(story.sources.map((s) => s.outletId).sort()).toEqual(["ht", "toi"]);
    expect(story.angles).toHaveLength(1);

    // Fact sheet: the three shared claims; the single-outlet cost claim is not on it.
    const facts = db.prepare("SELECT text FROM fact_claims WHERE status = 'corroborated'").all() as { text: string }[];
    expect(facts.map((f) => f.text).sort()).toEqual([...BRIDGE].sort());

    // Run log: every agent wrote a step for the event, the Picture Desk as skipped.
    const steps = db.prepare("SELECT agent, status, note, model FROM steps WHERE event_id IS NOT NULL ORDER BY id").all() as { agent: string; status: string; note: string; model: string | null }[];
    expect(steps.map((s) => s.agent)).toEqual(["Desk Sorter", "Fact Checker", "Rewrite Desk", "Copy Editor", "Picture Desk", "Press Room"]);
    expect(steps.find((s) => s.agent === "Picture Desk")!.status).toBe("skipped");
    expect(steps.every((s) => s.note.length > 0)).toBe(true);
    expect(db.prepare("SELECT COUNT(*) n FROM steps WHERE agent = 'Wire Scout'").get()).toEqual({ n: 1 });
  });

  it("NEVER prints a single-outlet event: it waits, is rechecked, then expires", async () => {
    const feeds = { [feedUrl("toi")]: [item(article("https://toi.example/dam", "Staff A", DAM), "Tehri dam gates opened"), item(article("https://toi.example/dam-2", "Staff C", DAM), "Dam gates opened, villages alerted")] };
    const w = world(feeds);
    await sweep({ db, ...w });
    expect(status(db)).toMatchObject([{ status: "waiting" }]);
    expect(status(db)[0].status_note).toMatch(/1 independent outlet/);
    expect(getPrintedStories(db)).toEqual([]);

    await sweep({ db, ...w }); // rechecked every sweep
    expect(db.prepare("SELECT recheck_count FROM events").get()).toEqual({ recheck_count: 2 });
    expect(status(db)[0].status).toBe("waiting");

    await sweep({ db, ...w, now: () => new Date(NOW.getTime() + 13 * 3600_000) }); // past WAITING_TTL_HOURS
    expect(status(db)).toMatchObject([{ status: "spiked", status_reason: "expired_unconfirmed" }]);
    expect(db.prepare("SELECT COUNT(*) n FROM angles").get()).toEqual({ n: 0 });
  });

  it("prints a waiting event once a second outlet reports it", async () => {
    const toi = { [feedUrl("toi")]: [item(article("https://toi.example/bridge", "Staff A", BRIDGE), "Kosi bridge opens")] };
    await sweep({ db, ...world(toi) });
    expect(status(db)[0].status).toBe("waiting");
    const both = { ...toi, [feedUrl("hindu")]: [item(article("https://hindu.example/bridge-x", "Staff H", BRIDGE), "Bridge across the Kosi opened")] };
    await sweep({ db, ...world(both) });
    expect(status(db)).toMatchObject([{ status: "printed", outlet_count: 2 }]);
  });

  it("does not print when two sites carry the same PTI copy", async () => {
    const feeds = {
      [feedUrl("toi")]: [item(article("https://toi.example/bridge", "PTI", BRIDGE), "Kosi bridge opens")],
      [feedUrl("ht")]: [item(article("https://ht.example/bridge-x", "PTI", BRIDGE), "Kosi bridge opened by CM")],
    };
    await sweep({ db, ...world(feeds) });
    expect(status(db)).toMatchObject([{ status: "waiting", outlet_count: 1 }]);
    expect(status(db)[0].status_note).toMatch(/same wire copy/);
    expect(getPrintedStories(db)).toEqual([]);
  });

  it("does not print on two corroboration-only outlets alone", async () => {
    const feeds = {
      [feedUrl("ndtv")]: [item(article("https://ndtv.example/bridge", "Staff N", BRIDGE), "Kosi bridge opens")],
      [feedUrl("hindu")]: [item(article("https://hindu.example/bridge-x", "Staff H", BRIDGE), "Kosi bridge opened by CM")],
    };
    await sweep({ db, ...world(feeds) });
    expect(status(db)[0].status).toBe("waiting");
  });

  it("spikes the story when the Copy Editor finds a sentence unsupported after one rewrite", async () => {
    const feeds = {
      [feedUrl("toi")]: [item(article("https://toi.example/bridge", "Staff A", BRIDGE), "Kosi bridge opens")],
      [feedUrl("ie")]: [item(article("https://ie.example/bridge-x", "Staff B", BRIDGE), "Kosi bridge inaugurated")],
    };
    await sweep({ db, ...world(feeds, { unsupported: ["word word"] }) });
    expect(status(db)).toMatchObject([{ status: "spiked", status_reason: "unsupported_copy" }]);
    const agents = (db.prepare("SELECT agent FROM steps WHERE event_id IS NOT NULL ORDER BY id").all() as { agent: string }[]).map((s) => s.agent);
    expect(agents).toEqual(["Desk Sorter", "Fact Checker", "Rewrite Desk", "Copy Editor", "Rewrite Desk", "Copy Editor"]);
    expect(getPrintedStories(db)).toEqual([]);
  });

  it("holds instead of printing when the desk rule is review or the presses are stopped", async () => {
    const feeds = {
      [feedUrl("toi")]: [item(article("https://toi.example/bridge", "Staff A", BRIDGE), "Kosi bridge opens")],
      [feedUrl("ie")]: [item(article("https://ie.example/bridge-x", "Staff B", BRIDGE), "Kosi bridge inaugurated")],
    };
    db.prepare("UPDATE desk_rules SET rule = 'review' WHERE desk = 'india'").run();
    await sweep({ db, ...world(feeds) });
    expect(status(db)).toMatchObject([{ status: "held", status_reason: "desk_review" }]);

    const db2 = openDb(":memory:");
    setSetting(db2, "presses_stopped", "1");
    await sweep({ db: db2, ...world(feeds) });
    expect(status(db2)).toMatchObject([{ status: "held", status_reason: "presses_stopped" }]);
    expect(getPrintedStories(db2)).toEqual([]);
  });

  it("keeps different events apart", async () => {
    const feeds = {
      [feedUrl("toi")]: [item(article("https://toi.example/bridge", "Staff A", BRIDGE), "Kosi bridge opens")],
      [feedUrl("ht")]: [item(article("https://ht.example/dam", "Staff B", DAM), "Kosi dam gates opened")],
    };
    await sweep({ db, ...world(feeds) });
    expect(status(db).map((e) => e.status)).toEqual(["waiting", "waiting"]);
  });
});
