/**
 * Live blogs and live-score pages. Their text keeps changing after we read
 * it, so they cannot back a claim: they are never grouped into events, never
 * read for claims and never shown as a source.
 */

const LIVE_WITH = /(score|scorecard|scores|updates?|blog|streaming|stream|commentary|coverage|cricket|match|telecast|result|counting)/;

export function isLiveBlog(url: string, title = ""): boolean {
  let path = url;
  try {
    path = decodeURIComponent(new URL(url).pathname);
  } catch {
    /* not a URL: treat the string as a path */
  }
  const p = path.toLowerCase();
  if (/liveblog|live-blog|\/live\/|\/live-updates?\/|\/live-news\//.test(p)) return true;
  // "…-live-score-…", "…-match-live-cricket-score-…", "…-live-updates-…"
  const words = p.split(/[^a-z0-9]+/).filter(Boolean);
  const i = words.indexOf("live");
  if (i !== -1 && words.slice(Math.max(0, i - 3), i + 4).some((w) => w !== "live" && LIVE_WITH.test(w))) return true;

  const t = title.trim();
  if (/\blive\s*(updates?|blog|score|scores|scorecard|streaming|coverage|commentary)\b/i.test(t)) return true;
  if (/(^|[\s|:–—-])LIVE\b\s*[:|–—-]/.test(t) || /\bLIVE$/.test(t) || /^live\b\s*[:|–—-]/i.test(t)) return true;
  if (/\b(highlights|as it happened)\s*:/i.test(t) || /\blive\b.*\bhighlights\b/i.test(t)) return true;
  return false;
}
