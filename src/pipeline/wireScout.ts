import { OUTLETS } from "@config/sources";
import { EVENT_WINDOW_HOURS } from "@/lib/env";
import { runStep } from "./runlog";
import type { Ctx } from "./types";

/**
 * Wire Scout: pull new reports from every configured feed, dedupe by URL and
 * store headline, the feed's own short summary and the link. Nothing else.
 */
export async function wireScout(ctx: Ctx): Promise<{ stored: number }> {
  return runStep(ctx, "Wire Scout", null, async () => {
    const insert = ctx.db.prepare(
      `INSERT OR IGNORE INTO reports (outlet_id, url, title, summary, feed_desk, published_at, fetched_at, byline)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const cutoff = ctx.now().getTime() - EVENT_WINDOW_HOURS * 3600_000;
    let stored = 0, seen = 0, unchanged = 0, stale = 0;
    const failed: string[] = [];

    // Feeds of one outlet go one after another (the fetcher also rate-limits
    // per host); different outlets run side by side.
    await Promise.all(
      OUTLETS.map(async (outlet) => {
        for (const feed of outlet.feeds) {
          try {
            const res = await ctx.fetchFeed(feed.url);
            if (res.notModified) {
              unchanged++;
              continue;
            }
            if (res.status !== 200) {
              failed.push(`${outlet.name} ${feed.desk} (HTTP ${res.status})`);
              continue;
            }
            for (const item of res.items) {
              seen++;
              if (new Date(item.publishedAt).getTime() < cutoff) {
                stale++;
                continue;
              }
              const r = insert.run(
                outlet.id, item.url, item.title, item.summary, feed.desk, item.publishedAt, ctx.now().toISOString(), item.author ?? null,
              );
              stored += Number(r.changes);
            }
          } catch (e) {
            failed.push(`${outlet.name} ${feed.desk} (${(e as Error).message})`);
          }
        }
      }),
    );

    const feeds = OUTLETS.reduce((n, o) => n + o.feeds.length, 0);
    if (failed.length === feeds) throw new Error(`every feed failed, e.g. ${failed[0]}`);
    const note =
      `Read ${feeds} feeds from ${OUTLETS.length} outlets: ${stored} new reports stored` +
      ` (${seen} items seen, ${stale} older than ${EVENT_WINDOW_HOURS}h skipped, ${unchanged} feeds unchanged)` +
      (failed.length ? `; ${failed.length} feed(s) failed: ${failed.slice(0, 3).join(", ")}` : "");
    return { note, value: { stored } };
  });
}
