import { fingerprintSimilarity, tokens } from "@/lib/text";
import { fetchModeOf, outletById } from "@config/sources";

/**
 * THE RULE the whole product rests on: how many *independent* outlets stand
 * behind a set of reports.
 *
 *  1. Two reports from the same outlet are one outlet.
 *  2. Reports credited to the same wire agency (PTI, ANI, ...) are one
 *     outlet, whichever sites carried them.
 *  3. Reports whose text is near-identical are one outlet, credited or not.
 *  4. A report whose URL slug is another outlet's headline, and not its
 *     own, shares that report's origin. Sites keep the slug of the copy they first published,
 *     so a page that started as agency copy and was later rewritten in place
 *     under a staff byline still shows where it came from. (Event #17: the
 *     Indian Express slug was The Hindu's PTI headline word for word, while
 *     the byline said "Express News Service" and the text no longer matched.)
 *  5. A report we could only read from a feed, with no byline, has unseen
 *     provenance: we cannot tell whether it is agency copy. It is never
 *     counted as independent of wire copy in the same event, nor of another
 *     unseen report with a near-identical headline.
 *
 * These links are transitive (if A and B share an outlet, and B and C are the
 * same PTI copy, then A, B and C count once). That is deliberately strict:
 * when in doubt we under-count, and the story waits.
 */

export interface OutletReport {
  id: number;
  outletId: string;
  wireAgency: string | null;
  fingerprint: number[] | null;
  url?: string;
  title?: string;
  /** True when we only saw a feed entry without a byline (rule 5). */
  unseen?: boolean;
}

export const NEAR_IDENTICAL = 0.6;
export const SLUG_MATCH = 0.8;
const SLUG_MIN_TOKENS = 5;
/** Below this share of slug words in its own headline, the page's headline has been rewritten. */
const OWN_HEADLINE_DRIFT = 0.6;

/** The words of an article URL's slug: its longest hyphenated path segment, ids and extensions removed. */
export function slugTokens(url: string): string[] {
  let path = url;
  try {
    path = decodeURIComponent(new URL(url).pathname);
  } catch {
    /* use as given */
  }
  const segment = path
    .split("/")
    .map((seg) => seg.replace(/\.(cms|html?|ece|php|aspx?)$/i, ""))
    .sort((a, b) => b.split("-").length - a.split("-").length)[0] ?? "";
  return tokens(segment.replace(/-/g, " ").replace(/\b\d{5,}\b/g, " "));
}

/** Share of `slug` words that appear in `title` (0..1). */
function containment(slug: string[], title: string[]): number {
  if (slug.length < SLUG_MIN_TOKENS) return 0;
  const set = new Set(title);
  return slug.filter((w) => set.has(w)).length / slug.length;
}

/**
 * Rule 4: does x's slug carry y's headline (or the other way round)?
 *
 * Similar headlines alone prove nothing: outlets reporting the same wedding
 * all lead with the same names. The signature of copy that was taken from
 * elsewhere is a slug that matches the OTHER outlet's headline while the
 * page's own headline has moved on. A slug that matches a wire-credited
 * report's headline also counts, even if the page kept that headline.
 */
export function slugCarriesHeadline(a: OutletReport, b: OutletReport): boolean {
  if (a.outletId === b.outletId) return false;
  const one = (x: OutletReport, y: OutletReport) => {
    if (!x.url || !y.title) return false;
    const slug = slugTokens(x.url);
    if (containment(slug, tokens(y.title)) < SLUG_MATCH) return false;
    return y.wireAgency !== null || containment(slug, tokens(x.title ?? "")) < OWN_HEADLINE_DRIFT;
  };
  return one(a, b) || one(b, a);
}

function headlineSimilarity(a: OutletReport, b: OutletReport): number {
  if (!a.title || !b.title) return 0;
  const ta = new Set(tokens(a.title));
  const tb = new Set(tokens(b.title));
  if (ta.size < 4 || tb.size < 4) return 0;
  let both = 0;
  for (const t of ta) if (tb.has(t)) both++;
  return both / (ta.size + tb.size - both);
}

/** Why two reports are counted as one source, or null if they are independent. */
export function sharedOrigin(a: OutletReport, b: OutletReport): string | null {
  if (a.outletId === b.outletId) return "same outlet";
  if (a.wireAgency !== null && a.wireAgency === b.wireAgency) return `same ${a.wireAgency} copy`;
  if (fingerprintSimilarity(a.fingerprint, b.fingerprint) >= NEAR_IDENTICAL) return "near-identical text";
  if (slugCarriesHeadline(a, b)) return "URL slug is the other outlet's headline";
  if ((a.unseen && b.wireAgency !== null) || (b.unseen && a.wireAgency !== null)) {
    return "feed-only report beside wire copy";
  }
  if (a.unseen && b.unseen && headlineSimilarity(a, b) >= NEAR_IDENTICAL) return "feed-only reports with the same headline";
  return null;
}

export function independentGroups(reports: OutletReport[]): OutletReport[][] {
  const parent = reports.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const union = (a: number, b: number) => {
    parent[find(a)] = find(b);
  };
  for (let i = 0; i < reports.length; i++) {
    for (let j = i + 1; j < reports.length; j++) {
      if (sharedOrigin(reports[i], reports[j])) union(i, j);
    }
  }
  const groups = new Map<number, OutletReport[]>();
  reports.forEach((r, i) => {
    const root = find(i);
    groups.set(root, [...(groups.get(root) ?? []), r]);
  });
  return [...groups.values()];
}

export const countIndependentOutlets = (reports: OutletReport[]): number => independentGroups(reports).length;

export interface Qualification {
  ok: boolean;
  count: number;
  reason: string;
}

/**
 * An event qualifies once minOutlets independent outlets have reported it and
 * at least one of them is a content outlet (corroboration-only outlets cannot
 * carry a story between themselves).
 */
export function qualifies(
  reports: OutletReport[],
  minOutlets: number,
  isContentOutlet: (outletId: string) => boolean = (id) => outletById(id)?.role === "content",
): Qualification {
  const count = countIndependentOutlets(reports);
  if (count < minOutlets) {
    const sites = new Set(reports.map((r) => r.outletId)).size;
    const why =
      sites >= minOutlets
        ? `${sites} sites carried it, but the copy traces to ${count} independent source${count === 1 ? "" : "s"} (same wire copy, or provenance we cannot see)`
        : `${count} independent outlet${count === 1 ? "" : "s"} so far`;
    return { ok: false, count, reason: `${why}; needs ${minOutlets}` };
  }
  if (!reports.some((r) => isContentOutlet(r.outletId))) {
    return { ok: false, count, reason: "only corroboration-only outlets have reported it; needs a content outlet" };
  }
  return { ok: true, count, reason: `${count} independent outlets` };
}

export interface OutletReportRow {
  id: number;
  outlet_id: string;
  wire_agency: string | null;
  fingerprint: string | null;
  url?: string;
  title?: string;
  byline?: string | null;
  text_source?: string | null;
}

export function toOutletReport(r: OutletReportRow): OutletReport {
  let fp: number[] | null = null;
  if (r.fingerprint) {
    try {
      fp = JSON.parse(r.fingerprint) as number[];
    } catch {
      fp = null;
    }
  }
  // Unseen provenance: read (or to be read) from the feed only, and the feed gave no byline.
  const feedOnly = r.text_source ? r.text_source === "feed_summary" : fetchModeOf(r.outlet_id) === "feed";
  return {
    id: r.id,
    outletId: r.outlet_id,
    wireAgency: r.wire_agency,
    fingerprint: fp,
    url: r.url,
    title: r.title,
    unseen: feedOnly && !r.byline && !r.wire_agency,
  };
}
