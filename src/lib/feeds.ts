/**
 * RSS / Atom reading. Copyright constraint: from a feed we keep only the
 * headline, the feed's own short summary and the link. Full text
 * (content:encoded, atom:content), images and enclosures are never returned.
 */
import { XMLParser } from "fast-xml-parser";
import { load } from "cheerio";
import { nowIso, type Db } from "./db";
import { politeFetch } from "./fetcher";

export interface FeedItem {
  url: string;
  title: string;
  summary: string;
  /** ISO 8601 UTC */
  publishedAt: string;
  /** Byline as the feed gives it (dc:creator / author), when it gives one. */
  author?: string;
}

const SUMMARY_MAX = 500;
const TRACKING_PARAMS = new Set(["fbclid", "gclid", "dclid", "msclkid", "mc_cid", "mc_eid", "igshid"]);

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  cdataPropName: "__cdata",
  textNodeName: "#text",
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: true,
  // Entities are decoded here, by hand, so that CDATA (literal) and escaped
  // text (one level of XML escaping) are each decoded exactly once.
  processEntities: false,
});

const XML_ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

function decodeXml(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (m, e: string) => {
    if (e[0] !== "#") return XML_ENTITIES[e.toLowerCase()] ?? m;
    const code = e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
    try {
      return String.fromCodePoint(code);
    } catch {
      return m;
    }
  });
}

/** The character content of a parsed element: CDATA taken literally, text XML-decoded. */
function content(node: unknown): string {
  if (node == null) return "";
  if (typeof node === "string") return decodeXml(node);
  if (typeof node === "number" || typeof node === "boolean") return String(node);
  if (Array.isArray(node)) return content(node[0]);
  if (typeof node === "object") {
    const o = node as Record<string, unknown>;
    const parts: string[] = [];
    const cdata = o.__cdata;
    if (Array.isArray(cdata)) parts.push(...cdata.map((c) => String(c ?? "")));
    else if (cdata != null) parts.push(String(cdata));
    if (typeof o["#text"] === "string") parts.push(decodeXml(o["#text"]));
    return parts.join(" ").trim();
  }
  return "";
}

/** HTML (or plain text with HTML entities) to plain text with collapsed whitespace. */
function htmlToText(html: string): string {
  if (!html) return "";
  if (!/[<&]/.test(html)) return html.replace(/\s+/g, " ").trim();
  const $ = load(`<div id="x">${html.replace(/<(?=\/?[a-zA-Z])/g, " <")}</div>`);
  $("script, style, noscript, iframe, figure, img").remove();
  return $("#x").text().replace(/\s+/g, " ").trim();
}

function capSummary(s: string): string {
  if (s.length <= SUMMARY_MAX) return s;
  const cut = s.slice(0, SUMMARY_MAX - 1);
  const space = cut.lastIndexOf(" ");
  return (space > SUMMARY_MAX * 0.6 ? cut.slice(0, space) : cut).replace(/[\s,;:.\-–—]+$/, "") + "…";
}

function cleanUrl(raw: string): string | null {
  const s = raw.trim();
  if (!s) return null;
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  u.hash = "";
  for (const key of [...u.searchParams.keys()]) {
    const k = key.toLowerCase();
    if (k.startsWith("utm_") || TRACKING_PARAMS.has(k)) u.searchParams.delete(key);
  }
  let out = u.toString();
  if (out.endsWith("?")) out = out.slice(0, -1);
  return out;
}

const TZ_ABBREVIATIONS: Record<string, string> = {
  IST: "+0530",
  UT: "+0000",
  UTC: "+0000",
  Z: "+0000",
};

function toIso(raw: string): string | null {
  const s = raw.trim();
  if (!s) return null;
  let t = Date.parse(s);
  if (Number.isNaN(t)) {
    const fixed = s.replace(/\b(IST|UTC|UT|Z)\s*$/i, (m) => TZ_ABBREVIATIONS[m.trim().toUpperCase()] ?? m);
    t = Date.parse(fixed);
  }
  if (Number.isNaN(t)) return null;
  return new Date(t).toISOString();
}

const asArray = <T>(v: T | T[] | undefined | null): T[] => (v == null ? [] : Array.isArray(v) ? v : [v]);

function atomLink(entry: Record<string, unknown>): string {
  const links = asArray(entry.link as unknown);
  let fallback = "";
  for (const l of links) {
    if (typeof l === "string") {
      fallback ||= decodeXml(l);
      continue;
    }
    const o = l as Record<string, unknown>;
    const href = typeof o["@_href"] === "string" ? decodeXml(o["@_href"] as string) : "";
    const rel = typeof o["@_rel"] === "string" ? (o["@_rel"] as string) : "alternate";
    if (href && rel === "alternate") return href;
    fallback ||= href;
  }
  return fallback;
}

function rssLink(item: Record<string, unknown>): string {
  for (const l of asArray(item.link as unknown)) {
    if (typeof l === "object" && l && typeof (l as Record<string, unknown>)["@_href"] === "string") {
      return decodeXml((l as Record<string, string>)["@_href"]); // atom:link inside RSS
    }
    const s = content(l);
    if (s) return s;
  }
  // Some feeds carry the permalink only in <guid>.
  const guid = asArray(item.guid as unknown)[0];
  const g = content(guid);
  const notPermalink =
    typeof guid === "object" && guid && (guid as Record<string, unknown>)["@_isPermaLink"] === "false";
  return !notPermalink && /^https?:\/\//i.test(g) ? g : "";
}

/** Parse an RSS 2.0 / RSS 1.0 / Atom document. Never throws: garbage yields []. */
export function parseFeed(xml: string): FeedItem[] {
  let doc: Record<string, unknown>;
  try {
    doc = parser.parse(xml.replace(/^\uFEFF/, "")) as Record<string, unknown>;
  } catch {
    return [];
  }
  if (!doc || typeof doc !== "object") return [];

  interface Raw {
    link: string;
    title: string;
    summary: string;
    date: string;
    author: string;
  }
  const raws: Raw[] = [];

  const rss = doc.rss as Record<string, unknown> | undefined;
  const rdf = doc["rdf:RDF"] as Record<string, unknown> | undefined;
  const feed = doc.feed as Record<string, unknown> | undefined;

  const rssItems: unknown[] = [];
  for (const channel of asArray(rss?.channel as unknown)) {
    if (channel && typeof channel === "object") rssItems.push(...asArray((channel as Record<string, unknown>).item));
  }
  if (rdf) rssItems.push(...asArray(rdf.item as unknown));

  for (const it of rssItems) {
    if (!it || typeof it !== "object") continue;
    const item = it as Record<string, unknown>;
    raws.push({
      link: rssLink(item),
      title: content(item.title),
      // description only: content:encoded is the full text and is not ours to keep
      summary: content(item.description),
      date: content(item.pubDate) || content(item["dc:date"]) || content(item.date) || content(item["atom:updated"]),
      author: asArray(item["dc:creator"] as unknown).map(content).filter(Boolean).join(", ") || content(item.author),
    });
  }

  for (const en of asArray(feed?.entry as unknown)) {
    if (!en || typeof en !== "object") continue;
    const entry = en as Record<string, unknown>;
    raws.push({
      link: atomLink(entry),
      title: content(entry.title),
      summary: content(entry.summary), // never atom:content
      date: content(entry.published) || content(entry.updated),
      author: asArray(entry.author as unknown)
        .map((a) => content(typeof a === "object" && a ? (a as Record<string, unknown>).name : a))
        .filter(Boolean)
        .join(", "),
    });
  }

  const now = nowIso();
  const seen = new Set<string>();
  const out: FeedItem[] = [];
  for (const r of raws) {
    const url = cleanUrl(r.link);
    const title = htmlToText(r.title);
    if (!url || !title || seen.has(url)) continue;
    seen.add(url);
    out.push({
      url,
      title,
      summary: capSummary(htmlToText(r.summary)),
      publishedAt: toIso(r.date) ?? now,
      ...(htmlToText(r.author) ? { author: htmlToText(r.author).slice(0, 200) } : {}),
    });
  }
  return out;
}

interface CacheRow {
  etag: string | null;
  last_modified: string | null;
}

/** Fetch a feed with a conditional GET, using and updating feed_cache. */
export async function fetchFeed(
  db: Db,
  url: string,
): Promise<{ status: number; notModified: boolean; items: FeedItem[] }> {
  const cached = db.prepare("SELECT etag, last_modified FROM feed_cache WHERE url = ?").get(url) as
    | CacheRow
    | undefined;

  const headers: Record<string, string> = {
    Accept: "application/rss+xml,application/atom+xml,application/xml;q=0.9,text/xml;q=0.9,*/*;q=0.5",
  };
  if (cached?.etag) headers["If-None-Match"] = cached.etag;
  if (cached?.last_modified) headers["If-Modified-Since"] = cached.last_modified;

  const res = await politeFetch(url, { headers });

  // Validators are replaced only by a 200; any other answer keeps the old ones.
  const etag = res.status === 200 ? res.headers.get("etag") : (cached?.etag ?? null);
  const lastModified = res.status === 200 ? res.headers.get("last-modified") : (cached?.last_modified ?? null);
  db.prepare(
    `INSERT INTO feed_cache (url, etag, last_modified, last_status, fetched_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(url) DO UPDATE SET etag = excluded.etag, last_modified = excluded.last_modified,
       last_status = excluded.last_status, fetched_at = excluded.fetched_at`,
  ).run(url, etag, lastModified, res.status, nowIso());

  if (res.status === 304) return { status: 304, notModified: true, items: [] };
  if (res.status !== 200) return { status: res.status, notModified: false, items: [] };
  return { status: 200, notModified: false, items: parseFeed(res.text) };
}
