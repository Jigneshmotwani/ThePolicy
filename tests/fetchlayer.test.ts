import { describe, expect, it } from "vitest";
import { parseRobots } from "@/lib/fetcher";
import { parseFeed } from "@/lib/feeds";
import { detectWireAgency, extractArticle } from "@/lib/article";

const UA = "thesecondsourcebot";

describe("parseRobots", () => {
  it("allows everything when there are no rules or the file is empty", () => {
    expect(parseRobots("", UA).isAllowed("/anything")).toBe(true);
    expect(parseRobots("User-agent: *\nDisallow:\n", UA).isAllowed("/anything")).toBe(true);
    expect(parseRobots("", UA).crawlDelayMs).toBeNull();
  });

  it("applies prefix rules from the * group", () => {
    const r = parseRobots("User-agent: *\nDisallow: /cgi-bin/\nDisallow: /search\n", UA);
    expect(r.isAllowed("/cgi-bin/x")).toBe(false);
    expect(r.isAllowed("/search?q=modi")).toBe(false);
    expect(r.isAllowed("/news/national/article1.ece")).toBe(true);
    expect(r.isAllowed("/")).toBe(true);
  });

  it("supports * wildcards", () => {
    const r = parseRobots("User-agent: *\nDisallow: */analysis-logger/*\nDisallow: /*?utm_\nDisallow: /cdn-cgi/*", UA);
    expect(r.isAllowed("/a/analysis-logger/b")).toBe(false);
    expect(r.isAllowed("/story.html?utm_source=x")).toBe(false);
    expect(r.isAllowed("/cdn-cgi/trace")).toBe(false);
    expect(r.isAllowed("/story.html")).toBe(true);
  });

  it("supports the $ end anchor", () => {
    const r = parseRobots("User-agent: *\nDisallow: /*.pdf$\nDisallow: /print$", UA);
    expect(r.isAllowed("/files/report.pdf")).toBe(false);
    expect(r.isAllowed("/files/report.pdf?download=1")).toBe(true);
    expect(r.isAllowed("/print")).toBe(false);
    expect(r.isAllowed("/printing-press")).toBe(true);
  });

  it("treats regex metacharacters in rules literally", () => {
    const r = parseRobots("User-agent: *\nDisallow: /a.b(c)+/", UA);
    expect(r.isAllowed("/a.b(c)+/x")).toBe(false);
    expect(r.isAllowed("/aXb(c)+/x")).toBe(true);
  });

  it("longest matching rule wins, and Allow wins a tie", () => {
    const r = parseRobots(
      ["User-agent: *", "Disallow: /news/", "Allow: /news/india/", "Disallow: /tie", "Allow: /tie"].join("\n"),
      UA,
    );
    expect(r.isAllowed("/news/world/x")).toBe(false);
    expect(r.isAllowed("/news/india/x")).toBe(true);
    expect(r.isAllowed("/tie/x")).toBe(true);
  });

  it("uses our own group instead of * when the site names us", () => {
    const txt = [
      "User-agent: *",
      "Disallow: /",
      "",
      "User-agent: TheSecondSourceBot",
      "Disallow: /private/",
      "Crawl-delay: 5",
    ].join("\n");
    const r = parseRobots(txt, UA);
    expect(r.isAllowed("/news/x")).toBe(true);
    expect(r.isAllowed("/private/x")).toBe(false);
    expect(r.crawlDelayMs).toBe(5000);
    // another crawler falls back to the * group
    expect(parseRobots(txt, "otherbot").isAllowed("/news/x")).toBe(false);
  });

  it("can be singled out for a full block, case-insensitively", () => {
    const txt = "User-agent: *\nAllow: /\n\nUser-Agent: THESECONDSOURCEBOT/0.1\nDisallow: /\n";
    expect(parseRobots(txt, UA).isAllowed("/news/x")).toBe(false);
    expect(parseRobots(txt, UA).isAllowed("/robots.txt")).toBe(true);
  });

  it("ignores groups for other bots, handles shared groups, comments and CRLF", () => {
    const txt =
      "# comment\r\nUser-agent: GPTBot\r\nUser-agent: CCBot\r\nDisallow: /\r\n\r\n" +
      "User-agent: Googlebot\r\nUser-agent: *\r\nDisallow: /amp/ # trailing comment\r\nCrawl-delay: 2\r\nSitemap: https://x.test/s.xml\r\n";
    const r = parseRobots(txt, UA);
    expect(r.isAllowed("/news/x")).toBe(true);
    expect(r.isAllowed("/amp/x")).toBe(false);
    expect(r.crawlDelayMs).toBe(2000);
  });
});

describe("parseFeed", () => {
  const rss = (items: string) =>
    `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:media="http://search.yahoo.com/mrss/"><channel><title>Feed</title><link>https://example.test</link>${items}</channel></rss>`;

  it("reads CDATA titles, descriptions and links", () => {
    const items = parseFeed(
      rss(`<item><title><![CDATA[Terror Attack On J&K CRPF Camp]]></title>
        <link><![CDATA[https://www.example.test/india/attack-1#publisher=newsstand]]></link>
        <description><![CDATA[The attack took <b>place</b> at
           Akhran.<p>More &amp; more.</p>]]></description>
        <pubDate><![CDATA[Wed, 11 Nov 2026 15:55:26 +0530]]></pubDate></item>`),
    );
    expect(items).toEqual([
      {
        url: "https://www.example.test/india/attack-1",
        title: "Terror Attack On J&K CRPF Camp",
        summary: "The attack took place at Akhran. More & more.",
        publishedAt: "2026-11-11T10:25:26.000Z",
      },
    ]);
  });

  it("decodes XML and HTML entities, including escaped HTML in descriptions", () => {
    const [a, b] = parseFeed(
      rss(`<item><title>&#8216;Pollution will go away&#8217; &amp; other claims</title>
          <link>https://example.test/a?id=1&amp;p=2</link>
          <description>&lt;a href="https://example.test/a"&gt;&lt;img src="https://example.test/i.jpg" /&gt;&lt;/a&gt;Rs&amp;nbsp;500 crore &amp;mdash; minister</description>
          <pubDate>Wed, 11 Nov 2026 08:38:08 +0000</pubDate></item>
        <item><title>Image only</title><link>https://example.test/b</link>
          <description>&lt;a href="https://example.test/b"&gt;&lt;img src="https://example.test/i.jpg" /&gt;&lt;/a&gt;<![CDATA[]]></description></item>`),
    );
    expect(a.title).toBe("\u2018Pollution will go away\u2019 & other claims");
    expect(a.url).toBe("https://example.test/a?id=1&p=2");
    expect(a.summary).toBe("Rs\u00a0500 crore \u2014 minister".replace(/\s+/g, " "));
    expect(b.summary).toBe("");
  });

  it("accepts RFC-822 and ISO dates and falls back to now", () => {
    const before = Date.now();
    const items = parseFeed(
      rss(`<item><title>One</title><link>https://example.test/1</link><pubDate>Wed, 11 Nov 2026 16:52:10 +0530</pubDate></item>
        <item><title>Two</title><link>https://example.test/2</link><pubDate>2026-11-11T16:52:10+05:30</pubDate></item>
        <item><title>Three</title><link>https://example.test/3</link><pubDate>Wed, 11 Nov 2026 11:22:10 GMT</pubDate></item>
        <item><title>Four</title><link>https://example.test/4</link><pubDate>Wed, 11 Nov 2026 16:52:10 IST</pubDate></item>
        <item><title>Five</title><link>https://example.test/5</link><pubDate>sometime soon</pubDate></item>
        <item><title>Six</title><link>https://example.test/6</link></item>`),
    );
    for (const it of items.slice(0, 4)) expect(it.publishedAt).toBe("2026-11-11T11:22:10.000Z");
    for (const it of items.slice(4)) {
      expect(it.publishedAt).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
      expect(Date.parse(it.publishedAt)).toBeGreaterThanOrEqual(before - 1000);
    }
    expect(items).toHaveLength(6);
  });

  it("drops items without a link or title, cleans URLs and dedupes", () => {
    const items = parseFeed(
      rss(`<item><title>No link</title></item>
        <item><link>https://example.test/no-title</link></item>
        <item><title>Not a URL</title><link>javascript:alert(1)</link></item>
        <item><title>A</title><link>https://example.test/a?utm_source=rss&amp;utm_medium=feed&amp;id=7&amp;fbclid=zz#top</link></item>
        <item><title>A again</title><link>https://example.test/a?id=7</link></item>
        <item><title>Guid only</title><guid isPermaLink="true">https://example.test/g?utm_campaign=x</guid></item>
        <item><title>Opaque guid</title><guid isPermaLink="false">https://example.test/?p=1</guid></item>`),
    );
    expect(items.map((i) => [i.title, i.url])).toEqual([
      ["A", "https://example.test/a?id=7"],
      ["Guid only", "https://example.test/g"],
    ]);
  });

  it("caps the summary at 500 characters", () => {
    const long = "Sentence number one is here. ".repeat(60);
    const [item] = parseFeed(rss(`<item><title>T</title><link>https://example.test/t</link><description>${long}</description></item>`));
    expect(item.summary.length).toBeLessThanOrEqual(500);
    expect(item.summary.length).toBeGreaterThan(300);
    expect(item.summary.startsWith("Sentence number one is here.")).toBe(true);
  });

  it("never leaks full text, images or enclosures", () => {
    const items = parseFeed(
      rss(`<item><title>T</title><link>https://example.test/t</link>
        <description><![CDATA[Short summary.<img src="https://example.test/SECRETIMG.jpg" alt="ALTTEXT">]]></description>
        <content:encoded><![CDATA[<p>FULLTEXT paragraph one.</p><p>FULLTEXT paragraph two.</p>]]></content:encoded>
        <enclosure type="image/jpeg" url="https://example.test/ENCLOSURE.jpg"/>
        <media:content url="https://example.test/MEDIA.jpg" medium="image"><media:description type="plain"><![CDATA[CAPTION]]></media:description></media:content>
        </item>
        <item><title>Empty description</title><link>https://example.test/u</link><description><![CDATA[]]></description>
        <content:encoded><![CDATA[<p>FULLTEXT only here.</p>]]></content:encoded></item>`),
    );
    expect(items).toHaveLength(2);
    expect(items[0].summary).toBe("Short summary.");
    expect(items[1].summary).toBe("");
    for (const it of items) expect(Object.keys(it).sort()).toEqual(["publishedAt", "summary", "title", "url"]);
    expect(JSON.stringify(items)).not.toMatch(/FULLTEXT|SECRETIMG|ALTTEXT|ENCLOSURE|MEDIA|CAPTION/);
  });

  it("reads a simple Atom feed without its content", () => {
    const items = parseFeed(`<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><title>F</title>
      <entry><title type="html">Atom &amp;amp; Eve</title><link rel="self" href="https://example.test/self"/>
        <link rel="alternate" href="https://example.test/atom-1?utm_source=x"/><updated>2026-11-11T11:22:10Z</updated>
        <summary>Brief.</summary><content type="html">FULLTEXT</content></entry></feed>`);
    expect(items).toEqual([
      { url: "https://example.test/atom-1", title: "Atom & Eve", summary: "Brief.", publishedAt: "2026-11-11T11:22:10.000Z" },
    ]);
  });

  it("returns [] for garbage", () => {
    expect(parseFeed("")).toEqual([]);
    expect(parseFeed("<html><body>Access Denied</body></html>")).toEqual([]);
    expect(parseFeed("not xml at all <<<")).toEqual([]);
  });
});

const para = (n: number, label = "Paragraph") =>
  `${label} ${n} says the minister announced a new scheme on Wednesday, and officials confirmed the details to reporters.`;
const paras = (count: number, label?: string) => Array.from({ length: count }, (_, i) => para(i + 1, label));

describe("extractArticle", () => {
  it("uses the JSON-LD articleBody (in @graph, with raw control characters) and its author", () => {
    const body = paras(6, "Sentence").join(" ");
    // a raw newline and tab inside a JSON string are invalid JSON; outlets ship them anyway
    const ld = `{"@context":"https://schema.org","@graph":[{"@type":"BreadcrumbList"},{"@type":"NewsArticle","headline":"H","author":[{"@type":"Person","name":" Asha Rao"},{"@type":"Person","name":"Vikram Singh"}],"articleBody":"${body.replace("Sentence 2", "\n\tSentence 2")} Tom &amp; Jerry agreed."}]}`;
    const html = `<html><head><script type="application/ld+json">${ld}</script></head><body><nav><p>${para(99, "Menu")}</p></nav><p>Too short.</p></body></html>`;
    const a = extractArticle(html);
    expect(a).not.toBeNull();
    expect(a!.text.startsWith("Sentence 1 says")).toBe(true);
    expect(a!.text).toContain("Sentence 6 says");
    expect(a!.text).toContain("Tom & Jerry agreed.");
    expect(a!.text).not.toMatch(/\t|Menu/);
    expect(a!.author).toBe("Asha Rao, Vikram Singh");
  });

  it("repairs glued JSON-LD paragraphs and strips outlet furniture", () => {
    const body = paras(5, "Line").join("") + "(With PTI inputs)Get the latest India News and Live updates. Download the TOI app.";
    const html = `<html><head><script type="application/ld+json">[{"@type":"WebPage"},{"@type":"NewsArticle","author":{"@type":"Person","name":"Staff Writer"},"articleBody":${JSON.stringify(body)}}]</script></head><body></body></html>`;
    const a = extractArticle(html)!;
    expect(a.text).toContain("reporters. Line 2 says");
    expect(a.text).not.toMatch(/TOI app|Get the latest/);
    expect(a.text.endsWith("(With PTI inputs)")).toBe(true);
    expect(a.author).toBe("Staff Writer");
    expect(detectWireAgency(a)).toBe("PTI");
  });

  it("falls back to <p> text from the article container, ignoring page furniture", () => {
    const html = `<html><head><meta name="author" content="By Meera Nair"></head><body>
      <nav><p>${para(1, "Navigation")}</p></nav>
      <article>
        <p>${para(1)}</p><p>Short one.</p>
        <figure><img src="x.jpg"><figcaption>${para(1, "Caption")}</figcaption></figure>
        <p>${para(2)}</p>
        <p>Also Read | <a href="/other">Another story entirely that has a long enough headline to pass</a></p>
        <p><a href="/teaser">A linked teaser headline for some other story on this very site today</a></p>
        <aside><p>${para(1, "Sidebar")}</p></aside>
        <blockquote class="twitter-tweet"><p>${para(1, "Tweet")}</p>&mdash; ANI (@ANI) November 11, 2026</blockquote>
        <p>${para(3)}</p><p>${para(4)}</p><p>${para(5)}&nbsp;&amp; more.</p>
        <p>With PTI inputs</p>
        <script>var x = "<p>${para(1, "Script")}</p>";</script>
      </article>
      <footer><p>${para(1, "Footer")}</p></footer></body></html>`;
    const a = extractArticle(html)!;
    expect(a.text.startsWith("Paragraph 1 says")).toBe(true);
    for (let i = 1; i <= 5; i++) expect(a.text).toContain(`Paragraph ${i} says`);
    expect(a.text).toContain("reporters. & more.");
    expect(a.text).not.toMatch(/Navigation|Caption|Sidebar|Tweet|Footer|Script|Short one|Also Read|teaser|@ANI/);
    expect(a.text.endsWith("With PTI inputs")).toBe(true); // short, but a credit line is kept
    expect(a.author).toBe("Meera Nair");
  });

  it("prefers a clean body container over a JSON-LD body padded with related-story junk", () => {
    const clean = paras(5);
    const dirty =
      clean.join(" https://example.test/link.ece ") +
      " Why the scheme matters | Explainer Why the scheme matters | Explainer " +
      "Another related headline here Another related headline here storyline 1";
    const html = `<html><head><script type="application/ld+json">{"@type":"NewsArticle","author":[{"@type":"Thing","name":"PTI"}],"articleBody":${JSON.stringify(dirty)}}</script></head>
      <body><div class="articlebodycontent"><div id="schemaDiv">${clean.map((p) => `<p>${p}</p>`).join("")}</div></div></body></html>`;
    const a = extractArticle(html)!;
    expect(a.text).toBe(clean.join("\n"));
    expect(a.author).toBe("PTI");
  });

  it("reads <br>-separated bodies that have no <p> at all", () => {
    const html = `<html><body><div data-articlebody="1"><div>${paras(5).join("<br><br>")}<br>(With PTI inputs)</div><div><a href="/x">Trending</a><a href="/y">Videos</a></div></div></body></html>`;
    const a = extractArticle(html)!;
    expect(a.text).toContain("Paragraph 5 says");
    expect(a.text).not.toMatch(/Trending|Videos/);
    expect(detectWireAgency(a)).toBe("PTI");
    expect(a.author).toBeNull();
  });

  it("returns null when there is too little text", () => {
    expect(extractArticle("")).toBeNull();
    expect(extractArticle("<html><body><h1>Access Denied</h1><p>You don't have permission.</p></body></html>")).toBeNull();
    expect(extractArticle(`<html><body><article><p>${para(1)}</p><p>${para(2)}</p></article></body></html>`)).toBeNull();
    expect(
      extractArticle(`<html><head><script type="application/ld+json">{"@type":"NewsArticle","articleBody":"Too short."}</script></head><body></body></html>`),
    ).toBeNull();
  });

  it("caps long text at 9000 characters on a sentence end and survives broken JSON-LD", () => {
    const html = `<html><head><script type="application/ld+json">{"@type": "NewsArticle", oops</script></head><body><article>${paras(200)
      .map((p) => `<p>${p}</p>`)
      .join("")}</article></body></html>`;
    const a = extractArticle(html)!;
    expect(a.text.length).toBeLessThanOrEqual(9000);
    expect(a.text.length).toBeGreaterThan(8000);
    expect(a.text.endsWith("reporters.")).toBe(true);
    expect(a.author).toBeNull();
  });
});

describe("detectWireAgency", () => {
  const body = paras(6).join(" ");

  it("reads the author field", () => {
    const cases: [string, string][] = [
      ["PTI", "PTI"],
      ["Press Trust of India", "PTI"],
      ["PTI | New Delhi", "PTI"],
      ["HT News Desk with PTI inputs", "PTI"],
      ["ANI", "ANI"],
      ["Asian News International", "ANI"],
      ["IANS", "IANS"],
      ["Reuters", "Reuters"],
      ["By Reuters", "Reuters"],
      ["AP", "AP"],
      ["Associated Press", "AP"],
      ["AFP", "AFP"],
      ["Agence France-Presse", "AFP"],
      ["Bloomberg", "Bloomberg"],
      ["Agencies", "AGENCY"],
      ["HT Correspondent, Agencies", "AGENCY"],
    ];
    for (const [author, code] of cases) expect([author, detectWireAgency({ author, text: body })]).toEqual([author, code]);
  });

  it("does not flag staff bylines", () => {
    for (const author of [
      "The Hindu Bureau", // as seen on thehindu.com
      "HT Correspondent", // hindustantimes.com
      "Express News Service", // indianexpress.com
      "Express Web Desk",
      "TOI World Desk", // timesofindia.indiatimes.com
      "Soumya Chatterjee",
      "Anil Kapoor",
      "AP Singh",
      "Ani Sharma",
      null,
    ]) {
      expect([author, detectWireAgency({ author, text: body })]).toEqual([author, null]);
    }
  });

  it("reads dateline credits at the top", () => {
    const cases: [string, string][] = [
      ["New Delhi, Nov 11 (PTI) The government on Wednesday said", "PTI"],
      ["WASHINGTON (Reuters) - The United States said on Wednesday", "Reuters"],
      ["Mumbai (Maharashtra) [India], November 11 (ANI): The actor said", "ANI"],
      ["KYIV, Ukraine (AP) — Delegations from Moscow and Kyiv", "AP"],
      ["Paris, Nov 11 (AFP) - French officials said", "AFP"],
      ["New Delhi, Nov 11 (IANS) The ministry said", "IANS"],
      ["(Bloomberg) -- Shares rose on Wednesday", "Bloomberg"],
      ["PTI: The government on Wednesday said", "PTI"],
    ];
    for (const [lead, code] of cases) expect([lead, detectWireAgency({ text: `${lead} ${body}` })]).toEqual([lead, code]);
  });

  it("reads trailing credits", () => {
    const cases: [string, string][] = [
      ["PTI ABC XYZ", "PTI"],
      ["PTI SKL RT RT", "PTI"],
      ["(With inputs from PTI)", "PTI"],
      ["(With PTI inputs)", "PTI"], // timesofindia.indiatimes.com
      ["With PTI inputs", "PTI"], // thehindu.com
      ["(With inputs from ANI and Reuters)", "ANI"],
      ["With inputs from agencies", "AGENCY"],
      ["(with agency inputs)", "AGENCY"],
      ["(Agencies)", "AGENCY"],
      ["- PTI", "PTI"],
      ["— Reuters", "Reuters"],
      ["(ANI)", "ANI"],
    ];
    for (const [credit, code] of cases) expect([credit, detectWireAgency({ text: `${body} ${credit}` })]).toEqual([credit, code]);
    expect(detectWireAgency({ text: `${body}\nWith PTI inputs` })).toBe("PTI");
  });

  it("reads the syndication disclaimers", () => {
    const ndtv = "(This story has not been edited by NDTV staff and is auto-generated from a syndicated feed.)";
    const ht = "This article was generated from an automated news agency feed without modifications to text."; // hindustantimes.com
    const generic = "This story has been published from a wire agency feed without modifications to the text.";
    expect(detectWireAgency({ text: `${body} ${ndtv}` })).toBe("AGENCY");
    expect(detectWireAgency({ text: `${body} ${ht}` })).toBe("AGENCY");
    expect(detectWireAgency({ text: `${body} ${generic}` })).toBe("AGENCY");
    // the named agency wins when a credit appears with the disclaimer
    expect(detectWireAgency({ text: `${body} PTI ABC XYZ ${ndtv}` })).toBe("PTI");
    expect(detectWireAgency({ text: `${body} ${generic} Only the headline has been changed. (ANI)` })).toBe("ANI");
    expect(detectWireAgency({ author: "PTI", text: `Amaravati, : ${body} ${ht}` })).toBe("PTI"); // real HT shape
    expect(detectWireAgency({ text: `New Delhi, Nov 11 (PTI) ${body} ${ndtv}` })).toBe("PTI");
  });

  it("does not count a mention in the body", () => {
    const mentions = [
      `The minister told PTI that the scheme would begin next month. ${body}`,
      `${body} "We will appeal," he told PTI.`,
      `${body} The order said as quoted by news agency PTI.`,
      `${body} According to Reuters, the talks will resume next week.`,
      `According to Reuters, the talks will resume. ${body}`,
      `${body} They have not been substantiated publicly, and news agency Reuters could not verify them. No one named has been charged.`,
      `${body} (Visuals from the spot) — ANI (@ANI) November 11, 2026 The train derailed near the station, officials said.`,
      `${body} The video was shared by ANI on X, and the Associated Press later confirmed it with officials.`,
      body,
    ];
    for (const text of mentions) expect([text.slice(0, 60), detectWireAgency({ author: "Staff Reporter", text })]).toEqual([text.slice(0, 60), null]);
  });
});

// Cases from the first draft of this file, kept as a second, independent set of fixtures.
describe("fetch layer: original cases", () => {
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
});
