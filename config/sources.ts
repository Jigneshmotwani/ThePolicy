/**
 * Outlets and their official RSS feeds. To add an outlet, append an entry
 * here; nothing else needs to change.
 *
 * role "content"        a story needs at least one report from a content
 *                       outlet before it can qualify.
 * role "corroboration"  reports count as an independent outlet and confirm
 *                       claims, but corroboration-only outlets alone can
 *                       never carry a story.
 *
 * Feed URLs verified live on 2026-11-11 (HTTP 200, fresh items).
 *
 * `fetch` can be overridden per outlet without editing this file:
 *   FETCH_MODE_OVERRIDES=ie:full,nie:feed
 */

export const DESKS = ["india", "world", "business", "sport", "entertainment"] as const;
export type Desk = (typeof DESKS)[number];

export const DESK_LABELS: Record<Desk, string> = {
  india: "India",
  world: "World",
  business: "Business",
  sport: "Sport",
  entertainment: "Entertainment",
};

export type OutletRole = "content" | "corroboration";

/**
 * How much of an outlet we read.
 *  "full"  the article page is fetched for claim extraction.
 *  "feed"  headline and the feed's own summary only; the article page is
 *          never requested. Used where the outlet's robots.txt disallows AI
 *          crawlers (we respect the intent even though our user agent is not
 *          named), where the site refuses us, or where its terms have not
 *          been checked yet.
 */
export type FetchMode = "full" | "feed";

export interface Feed {
  url: string;
  /** The desk this feed mostly carries. A hint only: the Desk Sorter decides. */
  desk: Desk;
}

export interface Outlet {
  id: string;
  name: string;
  home: string;
  role: OutletRole;
  fetch: FetchMode;
  /** Hostnames this outlet publishes articles on (used to recognise a pasted link). */
  hosts: string[];
  feeds: Feed[];
}

const toi = (id: string) => `https://timesofindia.indiatimes.com/rssfeeds/${id}.cms`;
const ht = (s: string) => `https://www.hindustantimes.com/feeds/rss/${s}/rssfeed.xml`;
const ie = (s: string) => `https://indianexpress.com/section/${s}/feed/`;
const ndtv = (s: string) => `https://feeds.feedburner.com/${s}`;
const hindu = (s: string) => `https://www.thehindu.com/${s}/feeder/default.rss`;
const indiaToday = (id: number) => `https://www.indiatoday.in/rss/${id}`;
const nie = (s: string) => `https://www.newindianexpress.com/api/v1/collections/${s}.rss`;
const tribune = (s: string) => `https://publish.tribuneindia.com/newscategory/${s}/feed/`;

export const OUTLETS: Outlet[] = [
  {
    id: "toi",
    name: "Times of India",
    home: "https://timesofindia.indiatimes.com",
    role: "content",
    fetch: "full",
    hosts: ["timesofindia.indiatimes.com"],
    feeds: [
      { url: toi("-2128936835"), desk: "india" },
      { url: toi("296589292"), desk: "world" },
      { url: toi("1898055"), desk: "business" },
      { url: toi("4719148"), desk: "sport" },
      { url: toi("1081479906"), desk: "entertainment" },
    ],
  },
  {
    id: "ht",
    name: "Hindustan Times",
    home: "https://www.hindustantimes.com",
    role: "content",
    fetch: "full",
    hosts: ["www.hindustantimes.com"],
    feeds: [
      { url: ht("india-news"), desk: "india" },
      { url: ht("world-news"), desk: "world" },
      { url: ht("business"), desk: "business" },
      { url: ht("sports"), desk: "sport" },
      { url: ht("cricket"), desk: "sport" },
      { url: ht("entertainment"), desk: "entertainment" },
    ],
  },
  {
    id: "ie",
    name: "Indian Express",
    home: "https://indianexpress.com",
    role: "content",
    // robots.txt disallows named AI crawlers (ClaudeBot, GPTBot, ...): feed only.
    fetch: "feed",
    hosts: ["indianexpress.com"],
    feeds: [
      { url: ie("india"), desk: "india" },
      { url: ie("world"), desk: "world" },
      { url: ie("business"), desk: "business" },
      { url: ie("sports"), desk: "sport" },
      { url: ie("entertainment"), desk: "entertainment" },
    ],
  },
  {
    id: "ndtv",
    name: "NDTV",
    home: "https://www.ndtv.com",
    role: "corroboration",
    // Article pages answer 403 to our user agent: feed only.
    fetch: "feed",
    hosts: ["www.ndtv.com", "sports.ndtv.com", "www.ndtvprofit.com"],
    feeds: [
      { url: ndtv("ndtvnews-india-news"), desk: "india" },
      { url: ndtv("ndtvnews-world-news"), desk: "world" },
      { url: ndtv("ndtvprofit-latest"), desk: "business" },
      { url: ndtv("ndtvsports-latest"), desk: "sport" },
      { url: ndtv("ndtvmovies-latest"), desk: "entertainment" },
    ],
  },
  {
    id: "hindu",
    name: "The Hindu",
    home: "https://www.thehindu.com",
    role: "corroboration",
    // robots.txt disallows named AI crawlers: feed only.
    fetch: "feed",
    hosts: ["www.thehindu.com"],
    feeds: [
      { url: hindu("news/national"), desk: "india" },
      { url: hindu("news/international"), desk: "world" },
      { url: hindu("business"), desk: "business" },
      { url: hindu("sport"), desk: "sport" },
      { url: hindu("entertainment"), desk: "entertainment" },
    ],
  },
  // --- Proposed in iteration 2, pending the owner's approval (see HANDOFF) ---
  {
    id: "nie",
    name: "The New Indian Express",
    home: "https://www.newindianexpress.com",
    role: "corroboration",
    // robots.txt names no AI crawler; terms of use read, no clause on crawling or AI.
    fetch: "full",
    hosts: ["www.newindianexpress.com"],
    feeds: [
      { url: nie("india"), desk: "india" },
      { url: nie("world"), desk: "world" },
      { url: nie("business"), desk: "business" },
      { url: nie("sport"), desk: "sport" },
      { url: nie("entertainment"), desk: "entertainment" },
    ],
  },
  {
    id: "indiatoday",
    name: "India Today",
    home: "https://www.indiatoday.in",
    role: "corroboration",
    // robots.txt names no AI crawler, but the terms page could not be read: feed only until approved.
    fetch: "feed",
    hosts: ["www.indiatoday.in"],
    feeds: [
      { url: indiaToday(1206578), desk: "india" },
      { url: indiaToday(1206577), desk: "world" },
      { url: indiaToday(1206574), desk: "business" },
      { url: indiaToday(1206550), desk: "sport" },
      { url: indiaToday(1206533), desk: "entertainment" },
    ],
  },
  {
    id: "tribune",
    name: "The Tribune",
    home: "https://www.tribuneindia.com",
    role: "corroboration",
    // robots.txt names no AI crawler, but the terms page could not be read: feed only until approved.
    fetch: "feed",
    hosts: ["www.tribuneindia.com"],
    feeds: [
      { url: tribune("nation"), desk: "india" },
      { url: tribune("world"), desk: "world" },
      { url: tribune("business"), desk: "business" },
      { url: tribune("sports"), desk: "sport" },
    ],
  },
];

export const outletByHost = (host: string): Outlet | undefined =>
  OUTLETS.find((o) => o.hosts.includes(host.toLowerCase()));

export const outletById = (id: string): Outlet | undefined => OUTLETS.find((o) => o.id === id);
export const outletName = (id: string): string => outletById(id)?.name ?? id;

const overrides = new Map(
  (process.env.FETCH_MODE_OVERRIDES ?? "")
    .split(",")
    .map((p) => p.trim().split(":"))
    .filter((p): p is [string, FetchMode] => p.length === 2 && (p[1] === "full" || p[1] === "feed")),
);
export const fetchModeOf = (outletId: string): FetchMode =>
  overrides.get(outletId) ?? outletById(outletId)?.fetch ?? "feed";
