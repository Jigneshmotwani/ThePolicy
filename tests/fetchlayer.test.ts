import { describe, expect, it } from "vitest";
import { parseRobots } from "@/lib/fetcher";
import { parseFeed } from "@/lib/feeds";
import { detectWireAgency, extractArticle } from "@/lib/article";

describe("robots.txt", () => {
  const txt = `
User-agent: *
Allow: /
Disallow: /wp-admin/
Allow: /wp-admin/admin-ajax.php
Disallow: /*rssarticleshow*
Disallow: /print/*.html$
Crawl-delay: 2

User-agent: ClaudeBot
User-agent: GPTBot
Disallow: /

User-agent: TheSecondSourceBot
Disallow: /private/
`;
  it("uses the * group when the site does not name us", () => {
    const r = parseRobots(txt, "someotherbot");
    expect(r.isAllowed("/article/india/x-123/")).toBe(true);
    expect(r.isAllowed("/wp-admin/options.php")).toBe(false);
    expect(r.isAllowed("/wp-admin/admin-ajax.php")).toBe(true); // longer Allow wins
    expect(r.isAllowed("/india/rssarticleshow/1.cms")).toBe(false); // wildcard
    expect(r.isAllowed("/print/a.html")).toBe(false);
    expect(r.isAllowed("/print/a.html?x=1")).toBe(true); // $ anchor
    expect(r.crawlDelayMs).toBe(2000);
  });
  it("obeys a group that names us over the * group", () => {
    const r = parseRobots(txt, "thesecondsourcebot");
    expect(r.isAllowed("/private/a")).toBe(false);
    expect(r.isAllowed("/wp-admin/options.php")).toBe(true);
  });
  it("a blanket Disallow for a named bot applies to that bot", () => {
    expect(parseRobots(txt, "claudebot").isAllowed("/anything")).toBe(false);
  });
  it("no robots rules means allowed", () => {
    expect(parseRobots("", "x").isAllowed("/a")).toBe(true);
  });
});

describe("feed parsing", () => {
  const xml = `<?xml version="1.0"?><rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/"><channel>
  <item><title><![CDATA[Cabinet clears metro extension &amp; more]]></title>
    <link><![CDATA[https://example.com/a?utm_source=rss&id=7#top]]></link>
    <description><![CDATA[<p>Union minister said the <b>line</b> will open in 2028.</p><img src="x.jpg"/>]]></description>
    <content:encoded><![CDATA[FULL TEXT THAT MUST NOT LEAK]]></content:encoded>
    <pubDate>Wed, 11 Nov 2026 16:28:58 +0530</pubDate></item>
  <item><title>Markets end higher &amp; rupee steady</title><link>https://example.com/b</link>
    <description>${"long ".repeat(200)}</description><pubDate>2026-11-11T16:34:40+05:30</pubDate></item>
  <item><title>Duplicate</title><link>https://example.com/b</link><pubDate>Wed, 11 Nov 2026 10:00:00 GMT</pubDate></item>
  <item><title>No link</title></item>
  </channel></rss>`;
  const items = parseFeed(xml);
  it("keeps headline, short plain-text summary, link and UTC date", () => {
    expect(items).toHaveLength(2);
    expect(items[0]).toEqual({
      url: "https://example.com/a?id=7",
      title: "Cabinet clears metro extension & more",
      summary: "Union minister said the line will open in 2028.",
      publishedAt: "2026-11-11T10:58:58.000Z",
    });
    expect(items[1].title).toBe("Markets end higher & rupee steady");
    expect(items[1].publishedAt).toBe("2026-11-11T11:04:40.000Z");
  });
  it("caps the summary and never returns full text", () => {
    expect(items[1].summary.length).toBeLessThanOrEqual(500);
    expect(JSON.stringify(items)).not.toContain("FULL TEXT");
  });
  it("returns nothing for garbage", () => {
    expect(parseFeed("<html>Access Denied</html>")).toEqual([]);
  });
});

const para = "The state government announced a relief package for farmers hit by unseasonal rain across eleven districts on Tuesday. ";

describe("article extraction", () => {
  it("reads JSON-LD articleBody and author", () => {
    const html = `<html><head><script type="application/ld+json">${JSON.stringify({
      "@graph": [{ "@type": "NewsArticle", articleBody: para.repeat(5), author: [{ "@type": "Person", name: "PTI" }] }],
    })}</script></head><body><p>short</p></body></html>`;
    const a = extractArticle(html)!;
    expect(a.text.startsWith("The state government")).toBe(true);
    expect(a.author).toBe("PTI");
  });
  it("falls back to paragraphs in the article container, skipping page furniture", () => {
    const html = `<html><body><nav><p>${"Menu item that is quite long and should be ignored entirely. ".repeat(3)}</p></nav>
      <article>${[1, 2, 3, 4, 5].map((n) => `<p>Paragraph ${n}. ${para}</p>`).join("")}<p>Also read: something else entirely that we should not pick up here</p></article></body></html>`;
    const a = extractArticle(html)!;
    expect(a.text).not.toMatch(/Menu item|Also read/);
    expect(a.text.length).toBeGreaterThan(400);
    expect(a.author).toBeNull();
  });
  it("returns null when there is too little text", () => {
    expect(extractArticle("<html><body><p>Access Denied</p></body></html>")).toBeNull();
  });
});

describe("wire-agency detection", () => {
  const body = para.repeat(4);
  it.each([
    ["author field", { author: "PTI", text: body }, "PTI"],
    ["author spelled out", { author: "Press Trust of India", text: body }, "PTI"],
    ["dateline", { text: `New Delhi, Nov 11 (PTI) ${body}` }, "PTI"],
    ["ANI dateline", { text: `Mumbai (Maharashtra) [India], November 11 (ANI): ${body}` }, "ANI"],
    ["Reuters dateline", { text: `WASHINGTON (Reuters) - ${body}` }, "Reuters"],
    ["slug sign-off", { text: `${body} PTI ABC RT RT` }, "PTI"],
    ["with inputs from", { text: `${body} (With inputs from PTI)` }, "PTI"],
    ["TOI style", { text: `${body}(With PTI inputs)` }, "PTI"],
    ["unnamed agencies", { text: `${body} (With agency inputs)` }, "AGENCY"],
    // seen live on hindustantimes.com, author "PTI":
    ["HT disclaimer", { author: "HT News Desk", text: `${body} This article was generated from an automated news agency feed without modifications to text.` }, "AGENCY"],
  ])("%s", (_name, input, expected) => {
    expect(detectWireAgency(input as never)).toBe(expected);
  });
  it("does not flag staff copy that merely mentions an agency", () => {
    expect(detectWireAgency({ author: "Aastha Jha", text: `${body} The minister told PTI that surveys were under way. ${body}` })).toBeNull();
    expect(detectWireAgency({ author: "Express Web Desk", text: body })).toBeNull();
  });
});
