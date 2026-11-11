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
  feeds: Feed[];
}

const toi = (id: string) => `https://timesofindia.indiatimes.com/rssfeeds/${id}.cms`;
const ht = (s: string) => `https://www.hindustantimes.com/feeds/rss/${s}/rssfeed.xml`;
const ie = (s: string) => `https://indianexpress.com/section/${s}/feed/`;
const ndtv = (s: string) => `https://feeds.feedburner.com/${s}`;
const hindu = (s: string) => `https://www.thehindu.com/${s}/feeder/default.rss`;

export const OUTLETS: Outlet[] = [
  {
    id: "toi",
    name: "Times of India",
    home: "https://timesofindia.indiatimes.com",
    role: "content",
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
    feeds: [
      { url: hindu("news/national"), desk: "india" },
      { url: hindu("news/international"), desk: "world" },
      { url: hindu("business"), desk: "business" },
      { url: hindu("sport"), desk: "sport" },
      { url: hindu("entertainment"), desk: "entertainment" },
    ],
  },
];

export const outletById = (id: string): Outlet | undefined => OUTLETS.find((o) => o.id === id);
export const outletName = (id: string): string => outletById(id)?.name ?? id;
