import { type Db } from "@/lib/db";
import type { FeedItem } from "@/lib/feeds";
import { OUTLETS } from "@config/sources";
import { scriptedLlm, words } from "./helpers";

/** A scripted world for end-to-end tests: feeds, article pages and a model, none of them real. */

export const NOW = new Date("2026-11-11T12:00:00Z");
export const feedUrl = (outletId: string) => OUTLETS.find((o) => o.id === outletId)!.feeds[0].url;
export const item = (url: string, title: string): FeedItem => ({ url, title, summary: "", publishedAt: "2026-11-11T10:00:00.000Z" });

// Each fake article is a list of plain claims plus filler unique to that page (so the
// texts are not near-identical); the "model" extracts the claims verbatim.
export const FILLER = (tag: string) => Array.from({ length: 60 }, (_, i) => `${tag}${i}`).join(" ");
export const articles: Record<string, { author: string | null; claims: string[]; title?: string }> = {};
export const article = (url: string, author: string | null, claims: string[]) => { articles[url] = { author, claims }; return url; };

export const BRIDGE = ["The Kosi bridge opened on Tuesday.", "The bridge is four kilometres long.", "The chief minister opened the bridge."];
export const DAM = ["The Tehri dam gates were opened on Monday.", "Officials said water levels were safe.", "Two villages were alerted."];

export function world(feeds: Record<string, FeedItem[]>, opts: { unsupported?: string[]; roles?: string[] } = {}) {
  const llm = scriptedLlm((system, user) => {
    if (system.startsWith("You sort incoming")) {
      return { items: user.split("\n").map((_, i) => ({ i, desk: "india", kind: "event" })) };
    }
    if (system.startsWith("You decide whether two")) {
      const topics = [...user.matchAll(/Headline: .*?(bridge|dam)/gi)].map((m) => m[1].toLowerCase());
      return { same_event: topics.length === 2 && topics[0] === topics[1] };
    }
    if (system.startsWith("An editor has named a topic")) {
      const topic = (/EDITOR'S TOPIC: (.*)/.exec(user)?.[1] ?? "").toLowerCase().split(/\s+/);
      const hit = [...user.matchAll(/^(\d+)\. (.*)$/gm)].find((m) => topic.some((t) => t.length > 3 && m[2].toLowerCase().includes(t)));
      return { match: hit ? Number(hit[1]) : null };
    }
    if (system.startsWith("You extract factual claims")) {
      const claims = user.split("\n").slice(3).join(" ").match(/[A-Z][^.]*\./g) ?? [];
      return { claims };
    }
    if (system.startsWith("You build a fact sheet")) {
      const byText = new Map<string, string[]>();
      for (const m of user.matchAll(/^(R\d+\.\d+): (.*)$/gm)) byText.set(m[2], [...(byText.get(m[2]) ?? []), m[1]]);
      return { facts: [...byText].map(([text, support], i) => ({ text, support, role: opts.roles?.[i] ?? (i === 0 ? "core" : "supporting") })), conflicts: [] };
    }
    if (system.startsWith("You are the rewrite desk")) {
      return { headline: "Kosi bridge opens to traffic", body: `The Kosi bridge opened on Tuesday. Then ${words(21)}. Later ${words(21)}.` };
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
    log: (l: string) => { if (process.env.TEST_LOG) console.log(l); },
    fetchFeed: async (url: string) => ({ status: 200, notModified: false, items: feeds[url] ?? [] }),
    fetchArticle: async (url: string) => {
      const a = articles[url];
      return a ? { author: a.author, text: `${a.claims.join(" ")} ${FILLER(url.replace(/[^a-z]/g, ""))}` } : null;
    },
    fetchPage: async (url: string) => {
      const a = articles[url];
      return a ? { headline: { title: a.title ?? "Untitled", summary: "", author: a.author }, article: { author: a.author, text: a.claims.join(" ") } } : null;
    },
  };
}

export const status = (db: Db) =>
  db.prepare("SELECT label, status, status_reason, status_note, outlet_count FROM events ORDER BY id").all() as {
    label: string; status: string; status_reason: string | null; status_note: string; outlet_count: number;
  }[];

