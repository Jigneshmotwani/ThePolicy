/**
 * Reading an outlet's article page. The text returned here is used inside a
 * sweep for claim extraction and is never written to the database.
 */
import { load } from "cheerio";
import { politeFetch } from "./fetcher";

export interface ArticleText {
  text: string;
  author: string | null;
}

const MIN_CHARS = 400;
const MAX_CHARS = 9000;

const squash = (s: string) => s.replace(/\s+/g, " ").trim();

function capAtSentence(s: string): string {
  if (s.length <= MAX_CHARS) return s;
  const cut = s.slice(0, MAX_CHARS);
  const end = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("? "), cut.lastIndexOf("! "));
  return end > MAX_CHARS * 0.6 ? cut.slice(0, end + 1) : cut;
}

/** Walk any JSON-LD value and collect article bodies and author names. */
function walkLd(node: unknown, out: { bodies: string[]; authors: string[] }, depth = 0): void {
  if (!node || depth > 8) return;
  if (Array.isArray(node)) {
    for (const n of node) walkLd(n, out, depth + 1);
    return;
  }
  if (typeof node !== "object") return;
  const o = node as Record<string, unknown>;
  if (typeof o.articleBody === "string") {
    out.bodies.push(o.articleBody);
    const authors = Array.isArray(o.author) ? o.author : o.author ? [o.author] : [];
    for (const a of authors) {
      const name = typeof a === "string" ? a : (a as Record<string, unknown>)?.name;
      if (typeof name === "string" && name.trim()) out.authors.push(squash(name));
      else if (Array.isArray(name)) out.authors.push(...name.filter((n) => typeof n === "string").map(squash));
    }
  }
  for (const v of Object.values(o)) if (v && typeof v === "object") walkLd(v, out, depth + 1);
}

function parseLd(raw: string): unknown {
  const s = raw.trim();
  try {
    return JSON.parse(s);
  } catch {
    try {
      // Outlets often leave raw newlines and tabs inside strings.
      return JSON.parse(s.replace(/[\u0000-\u001f]+/g, " "));
    } catch {
      return null;
    }
  }
}

const CONTAINERS = [
  "[itemprop='articleBody']",
  "div.story-details", // Indian Express
  "div#pcl-full-content", // Indian Express
  "div.storyDetails", // Hindustan Times
  "div.detail", // Hindustan Times
  "div.articlebodycontent", // The Hindu
  "div[data-articlebody]", // Times of India
  "div._s30J", // Times of India
  "article",
  "main",
];
const JUNK =
  "script, style, noscript, nav, footer, aside, header, form, figure, figcaption, iframe, button, svg, " +
  "[class*='related'], [class*='also-read'], [class*='alsoread'], [class*='newsletter'], [class*='subscribe'], " +
  "[class*='advert'], [class*='share'], [class*='comment'], [class*='breadcrumb'], [class*='tags']";
const BOILERPLATE = /^(also read|read more|read also|watch|follow us|subscribe|click here|download the|published\s*[-:]|updated\s*[-:]|first published|copyright|©|sign up|get the latest|catch all the)/i;

function paragraphText(html: string): string {
  const $ = load(html);
  let best = "";
  for (const sel of CONTAINERS) {
    $(sel).each((_, el) => {
      const box = $(el).clone();
      box.find(JUNK).remove();
      const paras: string[] = [];
      box.find("p").each((__, p) => {
        const t = squash($(p).text());
        if (t.length >= 40 && !BOILERPLATE.test(t)) paras.push(t);
      });
      const text = [...new Set(paras)].join(" ");
      if (text.length > best.length) best = text;
    });
    if (best.length >= MIN_CHARS) break; // most specific container that works wins
  }
  if (best.length < MIN_CHARS) {
    const body = $("body").clone();
    body.find(JUNK).remove();
    const paras: string[] = [];
    body.find("p").each((_, p) => {
      const t = squash($(p).text());
      if (t.length >= 60 && !BOILERPLATE.test(t)) paras.push(t);
    });
    const text = [...new Set(paras)].join(" ");
    if (text.length > best.length) best = text;
  }
  return best;
}

export function extractArticle(html: string): ArticleText | null {
  if (!html) return null;
  const $ = load(html);
  const ld = { bodies: [] as string[], authors: [] as string[] };
  $("script[type='application/ld+json']").each((_, el) => walkLd(parseLd($(el).text()), ld));

  const fromLd = ld.bodies
    .map((b) => squash(load(`<div>${b}</div>`).text()))
    .sort((a, b) => b.length - a.length)[0] ?? "";
  const fromPage = paragraphText(html);
  let text = fromLd.length >= fromPage.length ? fromLd : fromPage;
  if (text.length < MIN_CHARS) return null;
  text = text.replace(/\s*Get the latest [^.]{0,80}\.\s*Download the TOI app\.?\s*$/i, "").trim();

  const meta = squash($("meta[name='author']").attr("content") ?? "");
  const author = [...new Set(ld.authors)].join(", ") || meta || null;
  return { text: capAtSentence(text), author };
}

/* ---------- wire-agency credits ---------- */

const AGENCIES: [string, RegExp][] = [
  ["PTI", /\b(PTI|Press Trust of India)\b/],
  ["ANI", /\b(ANI|Asian News International)\b/],
  ["IANS", /\b(IANS|Indo-Asian News Service)\b/],
  ["Reuters", /\bReuters\b/i],
  ["AFP", /\b(AFP|Agence France-Presse)\b/],
  ["AP", /\b(AP|Associated Press)\b/],
  ["Bloomberg", /\bBloomberg\b/i],
];
const ANY = "PTI|ANI|IANS|Reuters|AFP|AP|Bloomberg";

function named(s: string): string | null {
  for (const [code, re] of AGENCIES) if (re.test(s)) return code;
  return null;
}

/**
 * Is this report agency copy? Returns the agency ("PTI", "ANI", ...), or
 * "AGENCY" when the copy is credited to unnamed agencies, or null for the
 * outlet's own reporting. A passing mention ("he told PTI") does not count.
 */
export function detectWireAgency(input: { author?: string | null; text: string }): string | null {
  const author = (input.author ?? "").trim();
  if (author) {
    const a = named(author);
    if (a) return a;
    if (/\b(agencies|agency|wire|syndicated feed|news service)\b/i.test(author)) return "AGENCY";
  }
  const text = input.text;
  const head = text.slice(0, 320);
  const tail = text.slice(-420);

  // Datelines: "New Delhi, Nov 11 (PTI)", "WASHINGTON (Reuters) -", "[India], November 11 (ANI):"
  const dateline = new RegExp(`\\((${ANY})\\)\\s*[:\\-–—]?`).exec(head);
  if (dateline && dateline.index < 160) return named(dateline[1]);
  // "PTI | New Delhi", "By PTI", "ANI:" right at the top
  const lead = new RegExp(`^\\W*(?:by\\s+)?(${ANY})\\s*(?:\\||:|,|-|–|—)`, "i").exec(head);
  if (lead) return named(lead[1].toUpperCase() === lead[1] ? lead[1] : lead[1][0].toUpperCase() + lead[1].slice(1));

  // Standard syndication disclaimers, anywhere.
  const disclaimer =
    /(not been edited by[^.]{0,80}staff[^.]{0,80}(syndicated|agency|wire) feed|auto-?generated from a syndicated feed|published from a (wire|syndicated)[^.]{0,40}feed|from a wire agency feed without modifications|from an automated news agency feed)/i.exec(text);
  if (disclaimer) return named(text.slice(Math.max(0, disclaimer.index - 200), disclaimer.index + 300)) ?? "AGENCY";

  // Sign-offs at the end: "(With inputs from PTI)", "- PTI", "PTI ABC XYZ" slug codes, "(ANI)".
  const inputs = new RegExp(`\\(?with (?:agency |wire )?inputs?(?: from)? (${ANY}|agencies|agency)\\)?`, "i").exec(tail);
  if (inputs) return named(inputs[1].toUpperCase()) ?? named(inputs[1]) ?? "AGENCY";
  const inputs2 = new RegExp(`\\(?with (${ANY}|agency|agencies|wire) (?:inputs|reports)\\)?`, "i").exec(tail);
  if (inputs2) return named(inputs2[1].toUpperCase()) ?? named(inputs2[1]) ?? "AGENCY";
  const slug = /\b(PTI|ANI|IANS)(?:\s+[A-Z]{2,5}){1,5}\s*$/.exec(tail);
  if (slug) return slug[1];
  const signoff = new RegExp(`(?:[-–—]\\s*|\\()(${ANY})\\)?\\s*$`).exec(tail.trimEnd());
  if (signoff) return named(signoff[1]);
  return null;
}

/** Fetch and read one article. Returns null when the page cannot be read; never throws for that. */
export async function fetchArticle(url: string): Promise<ArticleText | null> {
  try {
    const res = await politeFetch(url);
    if (res.status !== 200) return null;
    return extractArticle(res.text);
  } catch {
    return null; // robots.txt disallow, timeout, network error
  }
}
