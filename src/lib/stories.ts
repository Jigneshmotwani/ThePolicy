import { DESKS, DESK_LABELS, outletName, type Desk } from "../../config/sources";
import type { Db } from "./db";
import { isLiveBlog } from "../pipeline/liveblog";

export interface StorySource {
  outletId: string;
  name: string;
  href: string;
}
export interface StoryAngle {
  key: string;
  label: string;
  body: string;
}
export interface Story {
  id: number;
  desk: Desk;
  deskLabel: string;
  headline: string;
  printedAt: string /* ISO */;
  outletCount: number;
  sources: StorySource[];
  angles: StoryAngle[];
}

/** The reader never sees a story that fewer than this many outlets stand behind. */
const MIN_SOURCES = 2;

const isDesk = (d: string): d is Desk => (DESKS as readonly string[]).includes(d);
const isWebLink = (u: string) => /^https?:\/\//i.test(u);

/**
 * Printed stories, newest first. A story is only returned when it has a
 * headline, at least one angle and links to at least two outlets whose
 * reports support a corroborated claim.
 */
export function getPrintedStories(db: Db, limit = 60): Story[] {
  const events = db.prepare(
    `SELECT id, desk, headline, printed_at, outlet_count
       FROM events
      WHERE status = 'printed' AND headline IS NOT NULL AND TRIM(headline) <> ''
        AND printed_at IS NOT NULL
      ORDER BY printed_at DESC, id DESC`,
  );
  const anglesOf = db.prepare(
    `SELECT angle_key, label, body
       FROM angles
      WHERE event_id = ?
      ORDER BY (angle_key = 'general') DESC, id ASC`,
  );
  // Reports that support at least one corroborated claim of the event,
  // earliest first so the first row seen per outlet is its earliest report.
  const supportOf = db.prepare(
    `SELECT r.outlet_id, r.url, r.title
       FROM reports r
      WHERE r.id IN (
              SELECT s.report_id
                FROM fact_claim_support s
                JOIN fact_claims f ON f.id = s.fact_claim_id
               WHERE f.event_id = ? AND f.status = 'corroborated')
      ORDER BY r.published_at ASC, r.id ASC`,
  );

  const rows = events.all() as {
    id: number;
    desk: string;
    headline: string;
    printed_at: string;
    outlet_count: number;
  }[];

  const stories: Story[] = [];
  for (const e of rows) {
    if (stories.length >= limit) break;
    if (!isDesk(e.desk)) continue;
    if (e.outlet_count < MIN_SOURCES) continue;

    const angles = (anglesOf.all(e.id) as { angle_key: string; label: string; body: string }[])
      .filter((a) => a.body.trim() !== "")
      .map((a) => ({ key: a.angle_key, label: a.label, body: a.body.trim() }));
    if (angles.length === 0) continue;

    const byOutlet = new Map<string, StorySource>();
    for (const r of supportOf.all(e.id) as { outlet_id: string; url: string; title: string }[]) {
      // Live pages keep changing and are never offered as a source.
      if (byOutlet.has(r.outlet_id) || !isWebLink(r.url) || isLiveBlog(r.url, r.title)) continue;
      byOutlet.set(r.outlet_id, { outletId: r.outlet_id, name: outletName(r.outlet_id), href: r.url });
    }
    const sources = [...byOutlet.values()].sort((a, b) => a.name.localeCompare(b.name, "en"));
    if (sources.length < MIN_SOURCES) continue;

    stories.push({
      id: e.id,
      desk: e.desk,
      deskLabel: DESK_LABELS[e.desk],
      headline: e.headline.trim(),
      printedAt: e.printed_at,
      outletCount: e.outlet_count,
      sources,
      angles,
    });
  }
  return stories;
}
