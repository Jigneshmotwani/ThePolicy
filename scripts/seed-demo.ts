/**
 * Demo data for looking at the reader feed. Visual testing only.
 *
 *   DATABASE_PATH=./data/demo.db npx tsx scripts/seed-demo.ts
 *
 * Refuses to run unless DATABASE_PATH contains "demo", so it can never
 * write into the real database. Everything it inserts is fictional.
 */
import { env } from "../src/lib/env";
import { openDb } from "../src/lib/db";
import type { Desk } from "../config/sources";

const dbPath = process.env.DATABASE_PATH?.trim() ?? "";
if (!dbPath.toLowerCase().includes("demo") || env.databasePath !== dbPath) {
  console.error(
    'seed-demo: refusing to run. Set DATABASE_PATH to a file whose path contains "demo", e.g.\n' +
      "  DATABASE_PATH=./data/demo.db npx tsx scripts/seed-demo.ts",
  );
  process.exit(1);
}

interface Demo {
  desk: Desk;
  minutesAgo: number;
  headline: string;
  outlets: string[];
  claims: string[];
  body: string;
}

const DEMOS: Demo[] = [
  {
    desk: "sport",
    minutesAgo: 18,
    headline: "[Demo] Star batter turns founder with a sportswear label",
    outlets: ["toi", "ht", "ie"],
    claims: [
      "A fictional batter announced a sportswear label.",
      "The label opens with training kit.",
      "A signature bat grip is planned before the home season.",
    ],
    body: "The batter who made the cover drive a national habit is taking guard off the field. A sportswear label, confirmed this week, opens with training kit shaped by a career in the nets. Team-mates were first in the queue, and a signature bat grip follows before the home season begins. This is demo copy, not news.",
  },
  {
    desk: "business",
    minutesAgo: 50,
    headline: "[Demo] Central bank holds rates as prices cool",
    outlets: ["toi", "ie", "hindu"],
    claims: [
      "A fictional rate panel left its benchmark rate unchanged.",
      "Bond yields barely moved.",
      "The statement kept cautious wording on food prices.",
    ],
    body: "The rate-setting panel left the benchmark where it was, as most economists had forecast. Bond yields barely moved and bank stocks closed flat. The statement kept its cautious wording on food prices, which traders read as no cut before the next review. This paragraph is placeholder copy written for a visual test only.",
  },
  {
    desk: "world",
    minutesAgo: 95,
    headline: "[Demo] Climate talks run past deadline over finance text",
    outlets: ["ht", "ie", "ndtv"],
    claims: [
      "Fictional negotiators worked through a second extra night.",
      "The finance text stayed open.",
      "A revised draft is expected.",
    ],
    body: "Negotiators worked through a second extra night as the summit's finance text stayed open. Developing countries want firm figures; richer ones want a wider pool of donors. A revised draft is expected shortly, and the hosts say nobody leaves without one. None of this happened: it is specimen text for checking the page layout.",
  },
  {
    desk: "india",
    minutesAgo: 180,
    headline: "[Demo] State assembly passes heat-action bill",
    outlets: ["toi", "ht"],
    claims: [
      "A fictional state assembly passed a heat-action bill.",
      "Cities must publish a heat plan before each summer.",
      "Rules for employers follow after assent.",
    ],
    body: "Cities in the state must now publish a heat plan before each summer. The bill passed today requires cooling shelters, drinking-water points and changed hours for outdoor work on alert days. Rules for employers follow after the governor's assent. The state, the bill and the vote are invented for this demonstration page only.",
  },
  {
    desk: "entertainment",
    minutesAgo: 265,
    headline: "[Demo] Small-town drama sweeps the festival's top prizes",
    outlets: ["toi", "ie", "hindu"],
    claims: [
      "A fictional drama took best film at a fictional festival.",
      "It also took best director and the audience prize.",
      "The cast were first-time actors.",
    ],
    body: "A drama shot in a single lane of a small town took best film, best director and the audience prize at the festival. The jury praised its unhurried pace and a cast of first-time actors. It reaches cinemas next month with subtitles. The film and the festival do not exist; this is demo copy.",
  },
  {
    desk: "india",
    minutesAgo: 400,
    headline: "[Demo] Metro line opens two stations ahead of schedule in an entirely fictional city",
    outlets: ["ht", "ndtv", "hindu"],
    claims: [
      "A fictional metro line opened two stations early.",
      "Trains run every eight minutes at peak hours.",
      "The remaining stations are due next year.",
    ],
    body: "Two stations on the city's newest metro line opened to passengers this morning, weeks ahead of the published schedule. Trains run every eight minutes at peak hours and the first day's fares were waived. The remaining stations are due next year. The city, the line and the timetable are made up for testing a longer headline.",
  },
];

const db = openDb(dbPath);
const now = Date.now();
const iso = (msAgo: number) => new Date(now - msAgo).toISOString();
const words = (s: string) => s.trim().split(/\s+/).length;

db.exec("BEGIN");
try {
  // The demo database is disposable: start from a clean slate every run.
  for (const t of ["fact_claim_support", "fact_claims", "angles", "report_claims", "steps", "reports", "events"]) {
    db.exec(`DELETE FROM ${t}`);
  }

  const insEvent = db.prepare(
    `INSERT INTO events (label, desk, status, outlet_count, facts_stale, last_checked_at, headline,
                         created_at, updated_at, expires_at, printed_at)
     VALUES (?, ?, 'printed', ?, 0, ?, ?, ?, ?, ?, ?)`,
  );
  const insReport = db.prepare(
    `INSERT INTO reports (outlet_id, url, title, summary, feed_desk, published_at, fetched_at,
                          sort_status, event_id, text_source, claims_at)
     VALUES (?, ?, ?, '', ?, ?, ?, 'grouped', ?, 'feed_summary', ?)`,
  );
  const insClaim = db.prepare(
    "INSERT INTO fact_claims (event_id, text, status, created_at) VALUES (?, ?, 'corroborated', ?)",
  );
  const insSupport = db.prepare("INSERT INTO fact_claim_support (fact_claim_id, report_id) VALUES (?, ?)");
  const insAngle = db.prepare(
    `INSERT INTO angles (event_id, angle_key, label, body, word_count, created_at)
     VALUES (?, 'general', 'General', ?, ?, ?)`,
  );

  DEMOS.forEach((d, n) => {
    const printedAt = iso(d.minutesAgo * 60_000);
    const createdAt = iso((d.minutesAgo + 45) * 60_000);
    const eventId = Number(
      insEvent.run(
        d.headline,
        d.desk,
        d.outlets.length,
        printedAt,
        d.headline,
        createdAt,
        printedAt,
        iso(-12 * 3600_000),
        printedAt,
      ).lastInsertRowid,
    );
    const reportIds = d.outlets.map((outlet, k) =>
      Number(
        insReport.run(
          outlet,
          `https://example.com/demo/${outlet}/story-${n + 1}`,
          d.headline,
          d.desk,
          iso((d.minutesAgo + 40 - k * 7) * 60_000),
          createdAt,
          eventId,
          printedAt,
        ).lastInsertRowid,
      ),
    );
    for (const text of d.claims) {
      const claimId = Number(insClaim.run(eventId, text, printedAt).lastInsertRowid);
      for (const r of reportIds) insSupport.run(claimId, r);
    }
    insAngle.run(eventId, d.body, words(d.body), printedAt);
    console.log(`  ${d.desk.padEnd(13)} ${words(d.body)} words  ${d.headline}`);
  });
  db.exec("COMMIT");
} catch (e) {
  db.exec("ROLLBACK");
  throw e;
}
db.close();
console.log(`seed-demo: ${DEMOS.length} fictional printed stories written to ${dbPath}`);
