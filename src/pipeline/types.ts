import type { Db } from "@/lib/db";
import type { Llm } from "@/lib/llm";
import type { FeedItem } from "@/lib/feeds";
import type { ArticleText } from "@/lib/article";

export const AGENTS = [
  "Wire Scout",
  "Desk Sorter",
  "Fact Checker",
  "Rewrite Desk",
  "Copy Editor",
  "Picture Desk",
  "Press Room",
] as const;
export type Agent = (typeof AGENTS)[number];

export type StoryStatus = "waiting" | "working" | "held" | "printed" | "spiked" | "retracted";

/** Everything a stage needs from the outside world. Tests swap these out. */
export interface Ctx {
  db: Db;
  llm: Llm;
  sweepId: number;
  now: () => Date;
  fetchFeed: (url: string) => Promise<{ status: number; notModified: boolean; items: FeedItem[] }>;
  fetchArticle: (url: string) => Promise<ArticleText | null>;
  log: (line: string) => void;
}

export interface ReportRow {
  id: number;
  outlet_id: string;
  url: string;
  title: string;
  summary: string;
  feed_desk: string;
  published_at: string;
  sort_status: string;
  event_id: number | null;
  text_source: string | null;
  wire_agency: string | null;
  fingerprint: string | null;
  claims_at: string | null;
}

export interface EventRow {
  id: number;
  label: string;
  desk: string;
  status: StoryStatus;
  status_reason: string | null;
  status_note: string | null;
  outlet_count: number;
  facts_stale: number;
  recheck_count: number;
  fail_count: number;
  headline: string | null;
  created_at: string;
  expires_at: string;
  printed_at: string | null;
}

/** One corroborated claim and the reports behind it. */
export interface Fact {
  id: number;
  text: string;
  reportIds: number[];
}

export interface Draft {
  headline: string;
  body: string;
}
