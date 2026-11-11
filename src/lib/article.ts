/**
 * Article reading: pull the body text and byline out of an outlet's article
 * page, and decide whether the copy is wire-agency copy.
 *
 * The text returned here is used inside a sweep (claim extraction,
 * fingerprinting) and then dropped; it is never stored.
 */
import { load, type Cheerio, type CheerioAPI } from "cheerio";
import { politeFetch } from "./fetcher";

export interface ArticleText {
  text: string;
  author: string | null;
}

const MIN_CHARS = 400;
const MAX_CHARS = 9000;
const MIN_PARAGRAPH = 40;

// ---------------------------------------------------------------------------
// Wire agencies
// ---------------------------------------------------------------------------

interface Agency {
  code: string;
  /** Initials, matched case-sensitively ("AP" and "ANI" are also ordinary letters). */
  initials?: RegExp;
  /** The spelled-out name, matched in any case. */
  name?: RegExp;
}

const AGENCIES: Agency[] = [
  { code: "PTI", initials: /\bPTI\b/, name: /\bpress trust of india\b/i },
  { code: "ANI", initials: /\bANI\b/, name: /\basian news international\b/i },
  { code: "IANS", initials: /\bIANS\b/, name: /\bindo[- ]asian news service\b/i },
  { code: "Reuters", name: /\breuters\b/i },
  { code: "AFP", initials: /\bAFP\b/, name: /\bagence france[- ]presse\b/i },
  // not "A.P. Singh" / "AP Dhillon": initials followed by a surname are a person
  { code: "AP", initials: /\bAP\b(?![.-]|\s+[A-Z][a-z])/, name: /\bassociated press\b/i },
  { code: "Bloomberg", name: /\bbloomberg\b/i },
];

const CODES = "PTI|ANI|IANS|Reuters|REUTERS|AFP|AP|Bloomberg";
const GENERIC = "AGENCY";

function agencyIn(s: string): string | null {
  for (const a of AGENCIES) {
    if (a.initials?.test(s) || a.name?.test(s)) return a.code;
  }
  return null;
}

const canonical = (code: string): string => (code.toUpperCase() === "REUTERS" ? "Reuters" : code);

/** "(PTI)", "(Reuters) -", "(ANI):" as part of a dateline at the top of the copy. */
const DATELINE = new RegExp(`\\(\\s*(${CODES})\\s*\\)`);
/** "PTI: The government ..." / "New Delhi, PTI: ..." lead-in at the very start. */
const LEAD_IN = new RegExp(`^\\W{0,3}(?:[A-Z][A-Za-z. ]{2,30},\\s*)?(${CODES})\\s*(?:[:|–—]|-\\s)`);
/** PTI's sign-off slug: the agency followed by reporter/desk initials, e.g. "PTI ABC XYZ". */
const SLUG = /\b(PTI|ANI|IANS)\s+(?:[A-Z]{2,5}\d{0,2}\s+){0,5}[A-Z]{2,5}\d{0,2}(?=[\s.)]*$)/;
/** A sign-off at the very end: "... he said. - PTI", "— Reuters", "(ANI)", "(Agencies)", "... he said. PTI". */
const END_CREDIT = new RegExp(
  `(?:[—–-]\\s*|\\(\\s*)(${CODES}|[Aa]genc(?:y|ies))\\s*\\)?[\\s.]*$|[.!?"”’)]\\s+(PTI|ANI|IANS)[\\s.]*$`,
);
/** "(With inputs from PTI)", "with inputs from agencies", "With reporting from Reuters". */
const INPUTS_FROM = /\b(?:with\s+)?(?:additional\s+)?(?:inputs?|reporting|copy)\s+from\s+([^().\n]{2,80})/i;
/** "(With PTI inputs)", "with agency inputs", "With PTI and ANI inputs". */
const X_INPUTS = /\bwith\s+((?:[A-Za-z&-]+,?\s+(?:and\s+)?){1,4})(?:inputs?|copy)\b/i;
const UNNAMED = /\b(?:agenc(?:y|ies)|wires?|news service)\b/i;

const DISCLAIMERS: RegExp[] = [
  /not been edited by [^.]{0,120}?(?:syndicated|agency|wire) feed/i,
  /auto-?\s?generated from a[^.]{0,20}? (?:syndicated|news agency|agency|wire) feed/i,
  /(?:published|generated|taken|sourced) from an?[^.]{0,40}?(?:agency|wire|syndicated)[^.]{0,20}? feed/i,
  /feed without (?:any )?modifications? to (?:the )?text/i,
  /\bsyndicated feed\b/i,
];

const GENERIC_AUTHOR =
  /^(?:news\s+)?(?:agenc(?:y|ies)|wires?|wire (?:service|report|desk)s?|agency (?:report|feed|desk)s?|syndicated feed)$/i;

/**
 * Decide whether an article is wire-agency copy. Returns the agency code
 * ("PTI", "ANI", "IANS", "Reuters", "AP", "AFP", "Bloomberg"), "AGENCY" when
 * the copy is credited to an unnamed agency, or null.
 *
 * Only credits count: the byline, the dateline at the top, and the sign-off
 * or disclaimer at the bottom. "he told PTI" in the body is not a credit.
 */
export function detectWireAgency(input: { author?: string | null; text: string }): string | null {
  const author = (input.author ?? "").replace(/\s+/g, " ").trim();
  const text = (input.text ?? "").replace(/[ \t\r\f\v]+/g, " ").trim();

  // 1. Byline. Any agency named in the author field counts, including
  //    "PTI | New Delhi" and "HT News Desk with PTI inputs".
  if (author) {
    const named = agencyIn(author);
    if (named) return named;
    if (author.split(/\s*[,|/&]\s*|\s+and\s+|\s+with\s+/i).some((part) => GENERIC_AUTHOR.test(part.trim()))) {
      return GENERIC;
    }
  }

  const head = text.slice(0, 300);
  const tail = text.slice(-400);
  let generic = false;

  // 2. Dateline at the top: "New Delhi, Nov 11 (PTI)", "WASHINGTON (Reuters) -".
  const dateline = DATELINE.exec(head) ?? LEAD_IN.exec(head);
  if (dateline) return canonical(dateline[1]);

  // 3. "with inputs from ..." at the bottom.
  for (const re of [INPUTS_FROM, X_INPUTS]) {
    const m = re.exec(tail);
    if (!m) continue;
    const named = agencyIn(m[1]);
    if (named) return named;
    if (UNNAMED.test(m[1])) generic = true;
  }

  // 4. The syndication disclaimer, usually the last sentence; the agency's
  //    sign-off sits just before it.
  const last = text.slice(-700);
  let body = tail;
  for (const re of DISCLAIMERS) {
    const m = re.exec(last);
    if (!m) continue;
    generic = true;
    const start = Math.max(last.lastIndexOf(".", m.index - 1), last.lastIndexOf("\n", m.index - 1)) + 1;
    const named = agencyIn(last.slice(start)); // an agency named in the disclaimer itself
    if (named) return named;
    body = last.slice(0, start).slice(-400);
    break;
  }

  // 5. Sign-off at the very end: slug codes or a dash / bracket credit.
  for (const chunk of body === tail ? [tail] : [body.trimEnd(), tail]) {
    const slug = SLUG.exec(chunk);
    if (slug) return canonical(slug[1]);
    const end = END_CREDIT.exec(chunk);
    if (end) {
      const who = end[1] ?? end[2];
      if (/^agenc/i.test(who)) generic = true;
      else return canonical(who);
    }
  }

  return generic ? GENERIC : null;
}

// ---------------------------------------------------------------------------
// JSON-LD
// ---------------------------------------------------------------------------

const ARTICLE_TYPES = /(?:Article|Posting|Report)$/; // NewsArticle, Article, ReportageNewsArticle, BlogPosting, ...

/** JSON.parse that survives raw control characters, trailing commas and CDATA / comment wrappers. */
function parseJsonLoose(raw: string): unknown {
  let s = raw.trim();
  s = s.replace(/^\s*(?:\/\/\s*)?<!\[CDATA\[/, "").replace(/(?:\/\/\s*)?\]\]>\s*$/, "");
  s = s.replace(/^\s*<!--/, "").replace(/-->\s*$/, "").trim();
  if (!s) return undefined;
  try {
    return JSON.parse(s);
  } catch {
    /* fall through to the tolerant pass */
  }
  // Raw control characters are illegal inside JSON strings and are plain
  // whitespace outside them, so turning them all into spaces is safe.
  const cleaned = s.replace(/[\u0000-\u001f\u2028\u2029]+/g, " ").replace(/,\s*([}\]])/g, "$1");
  try {
    return JSON.parse(cleaned);
  } catch {
    return undefined;
  }
}

interface LdArticle {
  body: string;
  authors: string[];
}

function typeMatches(t: unknown): boolean {
  if (typeof t === "string") return ARTICLE_TYPES.test(t);
  return Array.isArray(t) && t.some((x) => typeof x === "string" && ARTICLE_TYPES.test(x));
}

function authorNames(a: unknown, out: string[] = []): string[] {
  if (a == null) return out;
  if (typeof a === "string") {
    out.push(a);
  } else if (Array.isArray(a)) {
    for (const x of a) authorNames(x, out);
  } else if (typeof a === "object") {
    const name = (a as Record<string, unknown>).name;
    if (typeof name === "string") out.push(name);
    else if (Array.isArray(name)) authorNames(name, out);
  }
  return out;
}

function collectLd(node: unknown, out: LdArticle[], depth = 0): void {
  if (node == null || depth > 6) return;
  if (Array.isArray(node)) {
    for (const n of node) collectLd(n, out, depth + 1);
    return;
  }
  if (typeof node !== "object") return;
  const o = node as Record<string, unknown>;
  if (typeMatches(o["@type"]) || typeof o.articleBody === "string") {
    out.push({
      body: typeof o.articleBody === "string" ? o.articleBody : "",
      authors: authorNames(o.author),
    });
  }
  for (const key of ["@graph", "mainEntity", "mainEntityOfPage"]) {
    if (o[key] && typeof o[key] === "object") collectLd(o[key], out, depth + 1);
  }
}

// ---------------------------------------------------------------------------
// Text cleaning
// ---------------------------------------------------------------------------

function decodeHtml(s: string): string {
  if (!/[<&]/.test(s)) return s;
  const $ = load(`<div id="x">${s.replace(/<(?=\/?(?:p|br|div|li|h\d)\b)/gi, "\n<")}</div>`);
  $("script, style, figure, figcaption").remove();
  return $("#x").text();
}

function tidy(s: string): string {
  return s
    .replace(/\u00a0/g, " ")
    .replace(/[\u200b-\u200d\ufeff]/g, "")
    .replace(/[ \t\r\f\v]+/g, " ")
    .replace(/ ?\n ?/g, "\n")
    .replace(/\n{2,}/g, "\n")
    .trim();
}

/** Page furniture that outlets append to the body text. */
const TRAILERS: RegExp[] = [
  /\s*Get the latest [^.]{0,80}\.\s*Download the TOI app\.?\s*$/i, // Times of India JSON-LD
  /\s*Download the TOI app\.?\s*$/i,
  /\s*Published\s*[-–—:]\s*[A-Z][a-z]+ \d{1,2}, \d{4}[^\n]{0,40}$/, // The Hindu
];
/** Embedded tweets leave "— Name (@handle) November 11, 2026" behind. */
const TWEET_CREDIT = /\s*(?:—|-)\s*[^()\n]{1,60}\(@\w{1,20}\)\s+[A-Z][a-z]+ \d{1,2}, \d{4}/g;

function stripFurniture(s: string): string {
  let out = s.replace(TWEET_CREDIT, " ");
  for (let pass = 0; pass < 2; pass++) for (const re of TRAILERS) out = out.replace(re, "");
  return out;
}

/**
 * JSON-LD bodies are machine-flattened and need more repair than the page:
 *  - paragraphs glued together with nothing between ("...West.The move...");
 *  - link targets left inline as bare URLs (The Hindu);
 *  - related-story cards and embeds flattened into the text, typically as a
 *    title repeated back to back (The Hindu), or a whole passage repeated.
 */
function cleanLdBody(raw: string): string {
  let s = tidy(decodeHtml(raw));
  s = s.replace(/\bhttps?:\/\/\S+/g, " ");
  s = s.replace(/(?<!\.[A-Za-z])([a-z0-9)][.!?]["”’)]?)(?=[A-Z“"(][A-Za-z])/g, "$1 ");
  s = tidy(s);
  // A card title repeated back to back marks where the related-stories block starts.
  const repeat = /(\S[^\n]{24,200}?)\s+\1(?=\s|$)/.exec(s);
  if (repeat && repeat.index > MIN_CHARS / 2) s = s.slice(0, repeat.index);
  // Drop sentences that already appeared (embeds are often serialised twice).
  const seen = new Set<string>();
  const deduped = s
    .split(/(?<=[.!?]["”’)]?)\s+/)
    .filter((sentence) => {
      const key = sentence.trim();
      if (key.length < 40) return true;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .join(" ");
  // never let the repair itself turn a usable body into an unusable one
  if (deduped.length >= MIN_CHARS || s.length < MIN_CHARS) s = deduped;
  return tidy(stripFurniture(s));
}

/** Cut to at most `max` characters, at a sentence end where there is one. */
function capText(s: string, max = MAX_CHARS): string {
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  let end = -1;
  const re = /[.!?]["”’)]?(?=\s)/g;
  for (let m = re.exec(cut); m; m = re.exec(cut)) end = m.index + m[0].length;
  if (end > max * 0.5) return cut.slice(0, end).trim();
  const space = cut.lastIndexOf(" ");
  return (space > 0 ? cut.slice(0, space) : cut).trim();
}

// ---------------------------------------------------------------------------
// Page paragraphs
// ---------------------------------------------------------------------------

/** Containers known to hold only the article body, most specific first. */
const BODY_CONTAINERS = [
  "[itemprop=articleBody]",
  "#pcl-full-content", // Indian Express
  ".story_details, .story-details", // Indian Express
  ".articlebodycontent", // The Hindu
  ".artContent", // Hindustan Times: the body is split over several of these
  ".storyDetails .detail", // Hindustan Times (older template)
  "[data-articlebody]", // Times of India: text and <br> in <div>s, no <p>
  "._s30J", // Times of India (older template)
  ".article-body, .article__content, .story-content, .entry-content, .post-content",
];
/** Whole-page fallbacks; these can hold more than the story. */
const LOOSE_CONTAINERS = ["article", "main"];

const NOISE =
  "script, style, noscript, template, iframe, svg, nav, footer, header, aside, form, button, figure, figcaption, " +
  "blockquote.twitter-tweet, blockquote.twitter-video, blockquote.instagram-media, blockquote.tiktok-embed, " +
  ".comments-box, .related-topics, .author-bio-all, .article-picture, .ad, .advertisement, " +
  "[class*=related], [class*=also-read], [class*=alsoread], [class*=newsletter], [class*=subscribe], " +
  "[class*=advert], [class*=breadcrumb], [class*=caption], [class*=social], [class*=share]";

const JUNK_LINE =
  /^(?:also read|also watch|also see|read more|read also|read\s*[:|]|watch\s*[:|]|see also|must read|don'?t miss|follow us|click here|subscribe|sign up|download the|get the latest|catch all the|published\s*[-–—:]|updated\s*[-–—:]|first published|\(?(?:image|photo|picture|representative image|file photo)s?\s*(?:credits?|courtesy)?\s*:|you use ai every day|advertisement|story continues below|recommended stories|copyright|©)/i;
/** Short lines are dropped as furniture unless they look like a wire credit. */
const CREDIT_LINE = new RegExp(`\\b(?:${CODES}|[Aa]genc(?:y|ies)|[Ii]nputs?|syndicated|feed)\\b`);

function keepLine(t: string): boolean {
  if (!t || JUNK_LINE.test(t)) return false;
  if (t.length >= MIN_PARAGRAPH) return true;
  return t.length >= 3 && CREDIT_LINE.test(t);
}

function paragraphsOf($: CheerioAPI, root: Cheerio<any>): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  root.find("p").each((_, el) => {
    const p = $(el);
    if (p.find("p").length) return; // malformed nesting: the inner ones are visited too
    const t = tidy(p.text()).replace(/\n/g, " ");
    // a paragraph that is nothing but a link is a teaser for another story
    const linkText = tidy(p.find("a").text()).replace(/\n/g, " ");
    if (linkText && linkText.length === t.length) return;
    if (!keepLine(t) || seen.has(t)) return;
    seen.add(t);
    out.push(t);
  });
  return out;
}

/** For templates that put the body in <div>s with <br> breaks instead of <p>. */
function looseLines($: CheerioAPI, root: Cheerio<any>): string[] {
  const box = root.clone();
  box.find("br").replaceWith("\n");
  box.find("div, section, li, h2, h3, h4, table, ul, p").each((_, el) => {
    $(el).prepend("\n").append("\n");
  });
  const out: string[] = [];
  const seen = new Set<string>();
  for (const line of box.text().split(/\n+/)) {
    const t = tidy(line);
    if (!keepLine(t) || seen.has(t)) continue;
    // prose has sentence punctuation; menus and link lists do not
    if (t.length >= MIN_PARAGRAPH && !/[.!?"”’:)]/.test(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out;
}

interface PageText {
  text: string;
  /** True when the text came from a container known to hold only the body. */
  specific: boolean;
  /** Short credit lines found at the end of the body ("With PTI inputs"). */
  credits: string[];
}

function pageText($: CheerioAPI): PageText {
  const finish = (lines: string[], specific: boolean): PageText => ({
    text: tidy(stripFurniture(lines.join("\n"))),
    specific,
    credits: lines.slice(-3).filter((l) => l.length < 200 && (CREDIT_LINE.test(l) || DISCLAIMERS.some((d) => d.test(l)))),
  });

  for (const sel of BODY_CONTAINERS) {
    const found = $(sel);
    if (!found.length) continue;
    const paras = paragraphsOf($, found); // all matches together, in document order
    if (paras.join("\n").length >= MIN_CHARS) return finish(paras, true);
    const loose = looseLines($, found.first());
    if (loose.join("\n").length >= MIN_CHARS) return finish(loose, true);
  }
  for (const sel of LOOSE_CONTAINERS) {
    // several <article>s on a page are other stories: take the fullest one only
    let best: string[] = [];
    $(sel).each((_, el) => {
      const paras = paragraphsOf($, $(el));
      if (paras.join("\n").length > best.join("\n").length) best = paras;
    });
    if (best.join("\n").length >= MIN_CHARS) return finish(best, false);
  }
  return finish(paragraphsOf($, $.root()), false);
}

function cleanAuthor(names: string[]): string | null {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const n of names) {
    const t = n.replace(/\s+/g, " ").replace(/^by\s+/i, "").trim();
    if (!t || t.length > 120 || /^https?:\/\//i.test(t) || seen.has(t.toLowerCase())) continue;
    seen.add(t.toLowerCase());
    out.push(t);
  }
  return out.length ? out.join(", ") : null;
}

/**
 * Extract the article body and byline from an article page.
 * Returns null when no body of at least 400 characters can be found.
 *
 * Two candidates are built: the JSON-LD articleBody and the paragraphs of
 * the article container. The longer one is used, except that paragraphs from
 * a container known to hold only the body are preferred when they are of
 * comparable length: on the outlets we read, a much longer JSON-LD body
 * means the page markup hid something, but a slightly longer one is just the
 * JSON-LD carrying embeds, link targets and related-story titles.
 */
export function extractArticle(html: string): ArticleText | null {
  if (!html || html.length < MIN_CHARS) return null;
  const $ = load(html);

  // (a) JSON-LD
  const ld: LdArticle[] = [];
  $('script[type="application/ld+json"]').each((_, el) => {
    const parsed = parseJsonLoose($(el).text() || $(el).html() || "");
    if (parsed !== undefined) collectLd(parsed, ld);
  });
  let ldText = "";
  for (const a of ld) {
    const t = cleanLdBody(a.body);
    if (t.length > ldText.length) ldText = t;
  }
  const withBody = ld.filter((a) => a.body && a.authors.length);
  const ldAuthors = (withBody.length ? withBody : ld).flatMap((a) => a.authors);

  const metaAuthor =
    $('meta[name="author"]').attr("content") ??
    $('meta[property="article:author"]').attr("content") ??
    $('meta[name="parsely-author"]').attr("content") ??
    "";
  const author = cleanAuthor(ldAuthors) ?? cleanAuthor(metaAuthor ? [metaAuthor] : []);

  // (b) paragraphs from the article container
  $(NOISE).remove();
  const page = pageText($);

  let text: string;
  if (page.text.length >= ldText.length) text = page.text;
  else if (page.specific && page.text.length >= MIN_CHARS && page.text.length >= ldText.length * 0.5) text = page.text;
  else {
    text = ldText;
    // Keep a wire credit the page shows but the JSON-LD dropped.
    for (const credit of page.credits) if (!text.includes(credit)) text += "\n" + credit;
  }
  if (text.length < MIN_CHARS) return null;

  if (text.length > MAX_CHARS) {
    // The cap cuts the end, which is where sign-off credits live: carry them over.
    const credits = text
      .slice(-400)
      .split("\n")
      .slice(1)
      .filter((l) => l.length < 200 && (CREDIT_LINE.test(l) || DISCLAIMERS.some((d) => d.test(l))));
    const room = MAX_CHARS - credits.reduce((n, c) => n + c.length + 1, 0);
    text = [capText(text, room), ...credits].join("\n");
  }
  return { text, author };
}

/**
 * Fetch and extract an article. Returns null on any non-200 answer (a 403 is
 * respected, not worked around), a robots.txt disallow, a network failure,
 * or when no article text can be extracted.
 */
export async function fetchArticle(url: string): Promise<ArticleText | null> {
  try {
    const res = await politeFetch(url);
    if (res.status !== 200) return null;
    return extractArticle(res.text);
  } catch {
    return null;
  }
}

export interface Headline {
  title: string;
  summary: string;
  author: string | null;
}

/** Headline, description and byline from an article page's own metadata. */
export function extractHeadline(html: string): Headline | null {
  const $ = load(html);
  const meta = (sel: string) => ($(sel).attr("content") ?? "").replace(/\s+/g, " ").trim();
  const title =
    meta("meta[property='og:title']") || meta("meta[name='twitter:title']") || $("h1").first().text().replace(/\s+/g, " ").trim() ||
    $("title").text().replace(/\s+/g, " ").trim();
  if (!title) return null;
  const summary = (meta("meta[property='og:description']") || meta("meta[name='description']")).slice(0, 500);
  return { title: title.slice(0, 300), summary, author: meta("meta[name='author']") || null };
}

/** Used when an editor pastes a link to an outlet we read in full. Null if the page cannot be read. */
export async function fetchPage(url: string): Promise<{ headline: Headline; article: ArticleText | null } | null> {
  try {
    const res = await politeFetch(url);
    if (res.status !== 200) return null;
    const headline = extractHeadline(res.text);
    return headline ? { headline, article: extractArticle(res.text) } : null;
  } catch {
    return null;
  }
}
