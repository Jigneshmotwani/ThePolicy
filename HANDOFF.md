# HANDOFF — The Second Source, iteration 2

Dependable pipeline, then the newsroom console at `/admin`. Written 12 Nov 2026. This replaces the iteration 1 handoff; anything from it that still matters is carried over here.

**Legend:** ✅ verified by running it live · 🧪 verified by automated test only · ⚠️ not verified.

## 1. What changed

### Part A: pipeline

| Item | What was done | Status |
|---|---|---|
| A1 Prove it runs | Three sweeps run to completion by hand, then `npm run worker` for 67 minutes: 12 sweeps, none failed. Numbers in §3. | ✅ |
| A2 Fetch modes | `fetch: "full" \| "feed"` per outlet in `config/sources.ts`. Indian Express, The Hindu and NDTV are feed-only: their article pages are never requested. Three outlets added as corroboration-only (§6). | ✅ |
| A3 Wire copy | Event #17 investigated, rule fixed, every printed story re-audited (§4). | ✅ |
| A4 Live blogs | Live and live-score pages are discarded before grouping, never read for claims, never counted, never shown as a source. | ✅ (1 discarded live in sweep 3; #53 retracted by the audit) |
| A5 Fact roles | Each claim is core, supporting or background; claims about another event are dropped; a story needs a corroborated core claim. | ✅ |
| A6 Copy quality | New Rewrite Desk brief (lead with the core fact, connected sentences, background only in passing) plus two mechanical checks (two to four sentences, no stub sentence). Copy Editor unchanged. | ✅ runs · only partly achieves the aim, see §8 |
| A7 Spend cap | `DAILY_BUDGET_USD` (default 5), counted midnight to midnight IST from the run log. At the cap, feeds are still read but no model call is made; the console says so. | ✅ with the cap lowered below the day's spend (the $5 cap was never reached naturally) |
| A8 Small fixes | Drop cap takes the whole run of initials ("US envoys", "PT Usha"). Conflict notes name outlets, not internal ids. | ✅ drop cap · 🧪 conflict notes (new notes seen live carry no ids) |

### Part B: console at `/admin`

| Requirement | Status |
|---|---|
| Password from `ADMIN_PASSWORD`, session cookie, every admin API route checks it, feed stays public | ✅ live (401 without a session, wrong password refused) · 🧪 every route, expired and forged sessions, cross-site POST refused |
| Stats row and "On the desk" table update without reload (4-second polling) | ✅ watched stories move Check → Write → Copy → Print |
| Filters by status and desk, search, paging; default is what is on the desk now | ✅ (460 waiting stories across 19 pages; search) |
| Run sheet: seven steps with note, status, duration, model, tokens, cost; fact sheet with outlets per claim; conflicts left out; draft or printed article | ✅ |
| Stop / restart the presses | ✅ |
| Auto-print or review-first per desk | ✅ |
| Approve and print a held story | ✅ story #740 held on a review desk, approved, appeared in the feed |
| Hold; release | ✅ |
| Spike | 🧪 (button wired the same way; not clicked live) |
| Retract with a reason; leaves the feed at once | ✅ story #200 (refused without a reason; gone from `/api/stories` immediately after) |
| Every action recorded with a timestamp (`admin_actions`) | ✅ shown on the run sheet |
| Send a link or topic; same checks; clear when waiting for a second outlet or matched nothing | ✅ five live submissions, see §5 |
| An admin cannot print a single-source story | 🧪 by test, and ✅ live in that two submissions were stopped by the outlet rules |
| "Sweep now" | ✅ sweep started 6 seconds after the click |
| Health strip: worker alive, last sweep time and duration, failures in it, spend against the cap | ✅ including "worker not running" and "daily budget reached" notices |
| Worker picks up submissions and "sweep now" within about ten seconds | ✅ 3-second tick; submissions answered in 4 to 12 seconds while a sweep was running |

Screenshots: `docs/console-run-sheet.png`, `docs/console-held.png`, `docs/console-budget.png`, `docs/feed-night.png`.

Tests: 153 pass (`npm test`). The ones you asked for: event #17 wire case, live-blog exclusion, core-claim rule, spend cap and manual submission never bypassing the two-outlet rule are in `tests/iteration2.test.ts`; admin auth on every admin route and retraction removing a story from the feed are in `tests/admin.test.ts`.

## 2. How to run it

As before (`npm install`, `.env` from `.env.example`, Node 22.13+), plus two new settings in `.env`:

```bash
ADMIN_PASSWORD=choose-something-long
```

```bash
DAILY_BUDGET_USD=5
```

Then, in two terminals:

```bash
npm run worker
```

```bash
npm run dev
```

The feed is at http://localhost:3000 and the console at http://localhost:3000/admin. With `ADMIN_PASSWORD` empty the console refuses every login. Other commands: `npm run sweep` (one sweep), `npm run report` (per-sweep numbers, waiting list, latest stories with fact sheets), `npm run audit` (re-audit printed stories under the current rules), `npm test`.

## 3. A1: the measured numbers

Sweeps 1 and 2 are iteration 1's unfinished ones. Sweep 3 was run by hand after Part A was written. **Sweeps 4 to 15 are the unattended worker run: 05:24 to 06:31 UTC on 12 Nov, 67 minutes, 12 sweeps, no failed sweep.**

| Sweep | Started (UTC) | Duration | New reports | Events to the desks | Printed | Held | Spiked | Back to waiting | Failed steps | Model calls | Tokens in | Tokens out | Cost USD |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 3 (by hand) | 11 Nov 20:12 | 21m 48s | 656 | 40 | 25 | 0 | 3 | 11 | 1 | 821 | 412,364 | 675,490 | 1.7292 |
| 4 | 12 Nov 05:24 | 14m 31s | 405 | 40 | 15 | 0 | 3 | 22 | 0 | 582 | 287,291 | 429,094 | 1.1045 |
| 5 | 05:38 | 5m 29s | 31 | 23 | 8 | 2 | 0 | 11 | 2 | 111 | 70,873 | 171,488 | 0.4863 |
| 6 | 05:44 | 3m 40s | 22 | 5 | 2 | 0 | 0 | 2 | 1 | 35 | 20,033 | 72,998 | 0.1908 |
| 7 | 05:49 | 1m 41s | 9 | 1 | 1 | 0 | 0 | 0 | 0 | 14 | 7,554 | 13,137 | 0.0335 |
| 8 (sweep now) | 05:51 | 0m 08s | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0.0000 |
| 9 | 05:56 | 0m 23s | 10 | 1 | 0 | 0 | 0 | 1 | 0 | 8 | 2,887 | 2,628 | 0.0028 |
| 10 | 06:01 | 0m 21s | 16 | 0 | 0 | 0 | 0 | 0 | 0 | 4 | 2,224 | 1,262 | 0.0014 |
| 11 | 06:06 | 0m 17s | 4 | 0 | 0 | 0 | 0 | 0 | 0 | 2 | 748 | 896 | 0.0008 |
| 12 | 06:11 | 0m 18s | 7 | 0 | 0 | 0 | 0 | 0 | 0 | 1 | 857 | 1,517 | 0.0012 |
| 13 | 06:16 | 0m 15s | 5 | 0 | 0 | 0 | 0 | 0 | 0 | 4 | 1,586 | 756 | 0.0009 |
| 14 | 06:21 | 0m 28s | 20 | 1 | 0 | 0 | 0 | 1 | 0 | 13 | 6,218 | 4,220 | 0.0057 |
| 15 | 06:26 | 0m 57s | 11 | 1 | 0 | 0 | 0 | 1 | 0 | 8 | 4,616 | 6,600 | 0.0172 |
| 17 (by hand, final code) | 06:33 | 2m 40s | 5 | 2 | 2 | 0 | 0 | 0 | 0 | 24 | 14,414 | 24,042 | 0.0664 |
| 18 (cap test) | 06:36 | 0m 08s | 4 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0.0000 |

Things to know when reading this table:

- **The run was not untouched.** While the worker ran I used the console on it as an editor would (§5): desk rules, five submissions, a hold and release, an approval, a retraction, a 3-second press stop, one "sweep now" (sweep 8). I did not touch the worker process. The 2 "held" in sweep 5 are from my putting the desks on review.
- **Sweep 16 has no row.** I ended the run with two stop signals instead of one, which cut sweep 16 off after it had read the feeds. That was my mistake, not a pipeline fault; it is recorded in the database as stopped by hand.
- **Failed steps: 4 in all, every one the Rewrite Desk** (one in sweep 3, three in the worker run). The cause was fact sheets holding only 34 to 44 words of agreed fact: the model would not pad to 45 words and used up its three attempts. One story (#693) was spiked after failing three times. Since fixed: a sheet too thin to fill 45 words now makes the story wait, with no failed step. 🧪 That fix is covered by a test; no thin sheet came up in the one sweep run after it.
- **Does rechecking waiting events cost model calls? No.** The recheck is a database query. 943 recheck steps have been written; model calls on them: 0. Sweep 8 rechecked 471 waiting events in 8 seconds for $0.

### Cost per hour

- **Measured, quiet period:** the last 42 minutes of the run (sweeps 7 to 15) cost **$0.07, about $0.10 an hour**, with 82 new reports and 4 events reaching the desks.
- **Measured, whole worker run:** **$1.87 in 67 minutes**, but $1.59 of that was the first two sweeps clearing what had built up while nothing was running.
- **Unit costs (measured over sweeps 3 to 15):** sorting $0.0002 per report; fact check $0.018 per event checked; writing $0.018 per story drafted; copy edit $0.004 per story. An event taken all the way costs about $0.04; each *printed* story has cost about $0.064 once the ones that waited or were spiked are counted.
- **A full day, estimated:** ⚠️ about **$7 to $8 a day, roughly $0.30 an hour on average**, more in the Indian daytime and near zero overnight. This is extrapolated, not observed: the outlets published about 1,490 reports in the last 24 hours, and from 11 Nov 12:00 UTC to the end of the run (18.5 hours of news) the pipeline spent $3.60 and let 84 qualified events expire unprocessed that would have cost about $2.50 more. The quiet-period figure above understates a day because stories first reported in those 42 minutes were mostly still waiting for their second outlet.

**So the $5 daily cap would be reached on a normal day at current settings.** Spend on the IST day of 12 Nov was $4.12, including $0.45 for the feed-mode experiment. Options are in §9.

## 4. A3: what happened with event #17, and the re-audit

**Is the Indian Express article PTI copy?** It began as PTI copy. Today the page is bylined "Express News Service" and its text is only 8% similar to The Hindu's PTI version, so neither the byline check nor the text-similarity check could see a link. But its URL slug, `pt-usha-fails-elected-som-saina-anju-bobby-george-voted-in`, is The Hindu's PTI headline word for word, while its own headline is different. Sites keep the slug of what they first published: the page went up as the agency story and was rewritten in place.

**The rule now** (`src/pipeline/outlets.ts`): a report whose URL slug carries another outlet's headline, and not its own, shares that report's origin. A slug matching a wire-credited report's headline counts even if the page kept the headline.

**My first version of this rule was wrong**, and the audit caught it. It linked any slug to any similar headline and would have retracted #385 (a wedding four outlets reported with near-identical, name-heavy headlines). I restored the database from a backup, narrowed the rule to the signature above, and added #385 as a test case.

**A second wire rule became necessary because of feed-only reading.** The Hindu's and NDTV's feeds carry no byline, so their PTI copy is now invisible to us. A report read from a feed with no byline is treated as "unseen provenance": it is never counted as independent of wire copy in the same event, nor of another unseen report with the same headline. This is strict on purpose.

**Re-audit of the 7 stories printed in iteration 1** (`npm run audit`):

| Story | Outlets before → after | Result |
|---|---|---|
| #17 PT Usha loses election | 3 → 2 | Kept. Indian Express and The Hindu now count once; Hindustan Times is the second. All 10 claims still have two sources. |
| #53 Rain washes out third ODI | 3 → 0 | **Retracted.** Its Hindustan Times and Indian Express sources were live-score pages; only The Hindu's PTI copy remained. |
| #43, #71, #325, #385 | unchanged | Kept. |
| #200 Maatrubhumi trailer | 5 → 5 | Kept by the audit, then **retracted by me through the console**: its printed copy carried a claim about a different event, the mix-up you flagged. |

## 5. The console, as exercised live

Done in a headless browser against the running worker and the real database:

- **Review desk → hold → approve:** with the desks on "review first", story #740 ("UK divorce, citizenship no shield from bigamy: SC") stopped at step 7, "Held for your sign-off". It was not in the feed. After "Approve and print" it was.
- **Submissions**, all answered within 4 to 12 seconds while a sweep was running:
  - A Hindustan Times link only HT had reported → "Waiting for a second outlet… 1 independent outlet so far; needs 2".
  - A New Indian Express link three corroboration-only outlets had reported → waiting for a content outlet.
  - A Hindustan Times link four sites carried → went onto the desks at once, and the Fact Checker stopped it: all four were AFP/ANI copy, one independent source.
  - A topic nobody had reported → "Matched nothing".
  - A link from an outlet we do not read → "Not accepted".
- **Hold and release** of a waiting story; **retraction** of #200; **stop and restart the presses**; **sweep now**.

One behaviour differs from iteration 1 and from a literal reading of the design: **while the presses are stopped the desks pause** (reports still come in and are grouped; nothing is checked or written), instead of writing stories and holding each one. A story already on the desks when you press stop finishes and is held; on restart it is printed if its desk is on auto-print. Tell me if you would rather every finished story waited for a sign-off.

The desk chosen in "Send a story" is used when a pasted link opens a new event; a link or topic that matches an existing event keeps that event's desk.

## 6. A2: fetch modes, the outlets proposed, and what feed-only costs

**Proposed outlets, added as corroboration-only. Please approve, change or remove:**

| Outlet | robots.txt | Terms | Mode set |
|---|---|---|---|
| The New Indian Express | No AI crawler named; general rules allow us ✅ | Terms of use read: nothing on crawling, automated access or AI ✅ | full |
| India Today | No AI crawler named ✅ | ⚠️ The terms page would not load its text (it redirected to a sister site's home page) | feed, until you approve |
| The Tribune | No AI crawler named ✅ | ⚠️ The terms page rendered empty | feed, until you approve |

Rejected on robots.txt: Deccan Herald, Financial Express, The Week, The Print, DNA, Mint, Economic Times, Outlook, The Quint. Unreachable to our user agent (403): Telegraph India, News18, Business Standard, Firstpost, Deccan Chronicle, Moneycontrol. Not tried further: Scroll, The Wire, The Statesman, DD News (no working feed found).

**Something you should know about the two outlets still read in full.** Times of India and Hindustan Times each disallow one named AI crawler, Meta's (`meta-externalagent`), and no other; Hindustan Times explicitly *allows* Google's AI token. I left both on "full". If "disallows AI crawlers" should include that, they go to feed-only too and the pipeline would be reading only The New Indian Express in full.

**What feed-only cost.** Measured on 10 events from iteration 1 whose Indian Express and Hindu articles had been read in full, rebuilt both ways with no page fetched again (`scripts/feedmode-experiment.ts`): **8 were printable with full text, 4 feed-only**, and corroborated claims per event fell from 8.2 to 3.2. Two of the four losses were events where The Hindu was the second source and its copy can no longer be told apart from wire copy. It is a small sample; treat "about half" as the finding, not "50%". Live, with the three new outlets partly making up for it: of 112 events taken to the desks in sweeps 3 to 15, 52 were printed, 36 went back to waiting, 6 were spiked by the Copy Editor.

Indian Express's feed gives a byline but an empty summary, so in feed mode it contributes its headline only.

## 7. Decisions and deviations in this iteration

1. **Waiting events expire 12 hours after their last new report**, whatever the reason they are waiting, and a new report resets the clock. This includes two-outlet events the desks never reached because of the 40-per-sweep cap or the budget: 84 expired that way (`status_reason = 'expired_unprocessed'`), nearly all backlog from the 8.5 hours when nothing was running.
2. **The queue is freshest-first** (editor submissions, then most recently reported), so the cap spends on new news.
3. **The fact-sheet call is skipped when it cannot succeed** (the second source offers fewer than three claims). Skipped 10 times live.
4. **Per-stage reasoning effort.** Fact sheet, writing and checking use the strong model with extended reasoning; claim extraction and Rewrite Desk retries use it without. I tested dropping reasoning from the fact sheet and rejected it: it called wording differences conflicts and kept 3 facts where the careful pass kept 11.
5. **An editor's change is never overridden by the pipeline.** Every status change the pipeline makes is conditional on the story still being where the pipeline left it.
6. **One admin API handler** (`src/lib/adminApi.ts`) serves every admin route and checks the session first, so a route cannot be added without the check. State-changing requests from another origin are refused. Sessions last 12 hours and live in SQLite. Wrong passwords are limited to 8 a minute.
7. **Audit and experiment costs are in the run log** as steps with no sweep, so the spend figure is complete.
8. **Dev-server fix.** `next dev` was reloading pages every time the worker wrote to the database, because the bundler tracked the project folder. Fixed in `src/lib/env.ts`.
9. Carried over from iteration 1 and confirmed by you: the content-outlet reading, `MIN_CLAIMS=3`, `MAX_EVENTS_PER_SWEEP=40`, the replacement fast model, one step per change for waiting rechecks.

## 8. Known gaps and problems

- **A6 is only partly met.** Leads now state the core fact and the stub sentences are gone, but bodies can still read as facts placed side by side ("US-mediated talks involving Russian and Ukrainian officials took place in Abu Dhabi." sits between two unrelated sentences). Background facts still sometimes get a clause of their own, and one printed story spends a sentence on "the company he led". See the samples in §10.
- **The thin-fact-sheet fix is test-only** (§3).
- **The cap was verified by lowering it, not by reaching $5.**
- **Rewrite Desk cost.** As dear per story as the fact check ($0.018), because a third of drafts need a second or third attempt to meet the length and shape rules.
- **Conflicts are sometimes over-called.** The fact sheet treats some differences of detail as disputes ("16 years" against "since June 2010") and leaves the point out. Safe, but it thins stories.
- **Spike rate.** The Copy Editor spiked 6 of about 60 drafted stories after the one rewrite. I have not reviewed whether each was right.
- **Story #693 was spiked by step failures** that the thin-sheet fix would now avoid. It is not revived automatically.
- **Wire copy on NDTV and The Hindu is invisible**; the unseen-provenance rule covers it by under-counting.
- **Console limits:** one shared password, no users or roles; held stories have no ageing or reminder; "Sweep now" is disabled when the worker is not running; topic matching relies on shared words, so a topic phrased very differently from the headlines will match nothing; no paper edition toggle in the console.
- **Touch swipe in the feed and the Spike button in the console** were not exercised live.
- **Printed stories are still never updated** when new facts arrive (out of scope).
- Still true from iteration 1: in this cloud sandbox the OpenAI SDK needs `NODE_USE_ENV_PROXY=1`; nothing of the sort on your machine.

## 9. What I need from you

1. **Approve the three outlets** in §6, and say whether India Today and The Tribune may be read in full once you have looked at their terms.
2. **Times of India and Hindustan Times block Meta's AI crawler only.** Keep them on full, or move them to feed-only?
3. **Cost against the cap.** A normal day is likely to cost $7 to $8, above the $5 default. Choices: raise `DAILY_BUDGET_USD` to about 10; or cut cost. The biggest single saving I measured is building the fact sheet on the fast model with reasoning on: $0.009 against $0.024 per sheet on three test events, similar fact counts, but on one of the three it missed conflicts the strong model caught. That trades away some care at the step the product depends on, so I did not switch.
4. **Feed-only halves what gets printed** on the sample measured. Is that acceptable, or would you ask Indian Express and The Hindu for permission?
5. **Presses stopped = desks paused** (§5). Keep, or hold finished stories instead?
6. **Expiry of unprocessed events** (§7.1). Keep, or let them wait indefinitely?
7. The ai& key is still a network secret on your Default cloud environment (see the iteration 1 note). `ADMIN_PASSWORD` in this sandbox is a random value in the git-ignored `.env`; set your own locally.

## 10. Five fresh sample stories

All printed on 12 Nov under the new rules. "Headline and feed summary only" marks reports from feed-only outlets.

#### Ramayana crosses ₹500cr net in India, ₹900cr worldwide

*entertainment desk · event #62 · printed 2026-11-12 06:36 UTC · 4 independent outlets · headline 54 chars · body 58 words*

> Ramayana has earned over ₹500 crore net in India and over ₹900 crore worldwide by its seventh day of release. The film, directed by Nitesh Tiwari and starring Ranbir Kapoor, Sai Pallavi, and Yash, grossed approximately Rs 526 crore in India within six days. It also earned Rs 5.15 crore in Thailand, where it released on November 5.

**Fact sheet**

- **core** · The film earned over ₹500 crore net in India by its seventh day of release. — NDTV, Times of India, Hindustan Times
- **core** · The film earned over ₹900 crore worldwide by its seventh day of release. — NDTV, Hindustan Times
- **supporting** · The film grossed approximately Rs 526 crore in India within six days of release. — Indian Express, Hindustan Times
- **supporting** · Ramayana earned approximately Rs 5.15 crore in Thailand. — Indian Express, Times of India
- **background** · The film is directed by Nitesh Tiwari. — Times of India, Hindustan Times
- **background** · The film stars Ranbir Kapoor as Lord Rama, Sai Pallavi as Goddess Sita, and Yash as Ravana. — Times of India, Hindustan Times
- **background** · Ramayana released in Indonesia on November 11. — Indian Express, Times of India
- **background** · Ramayana released in Thailand on November 5. — Indian Express, Times of India
- *(left out: outlets conflict)* Disputed Tuesday net collection in India: close to ₹100 crore versus ₹94 crore. — Hindustan Times
- *(left out: outlets conflict)* Disputed worldwide gross after six days: ₹823 crore versus ₹934.55 crore. — Hindustan Times, Times of India

**Sources**

- Hindustan Times: [Ramayana worldwide box office collection: Unstoppable Ranbir Kapoor, Yash film crosses ₹900 crore; beats Animal, Bajrangi Bhaijaan lifetime in a week](https://www.hindustantimes.com/entertainment/bollywood/ramayana-worldwide-box-office-collection-day-7-ranbir-kapoor-yash-sai-pallavi-film-900-crore-animal-bajrangi-bhaijaan-nitesh-tiwari-namit-malhotra-101794455927554.html)
- Hindustan Times: [Ramayana worldwide box office collection day 6: Back-to-back ₹150-crore days lift Ranbir Kapoor, Yash film past ₹800 crore; beats PK, Chhaava lifetime](https://www.hindustantimes.com/entertainment/bollywood/ramayana-worldwide-box-office-collection-day-6-ranbir-kapoor-yash-sai-pallavi-film-800-crore-beat-pk-chhaava-nitesh-tiwari-namit-malhotra-101794378129030.html)
- Indian Express: [Ramayana opens with fanfare in Indonesia, earns over Rs 5 cr in Thailand. See pics, videos](https://indianexpress.com/article/entertainment/bollywood/ramayana-release-indonesia-thailand-box-office-collection-southeast-asia-see-pictures-videos-10958357/)
- NDTV (headline and feed summary only): [Ramayana Box Office Collection Day 7: Ranbir Kapoor Film Crosses Rs 500 Crore Mark In India, Rs 900 Crore Worldwide](https://www.ndtv.com/entertainment/ramayana-box-office-collection-day-7-ranbir-kapoor-film-crosses-rs-500-crore-mark-in-india-rs-650-crore-worldwide-12315335)
- Times of India: ['Ramayana' Jakarta premiere: Ranbir and Yash starrer wins over Indonesian audiences](https://timesofindia.indiatimes.com/entertainment/hindi/bollywood/news/ramayana-rise-of-a-legend-jakarta-premiere-ranbir-kapoor-and-yash-starrer-wins-over-indonesian-audiences-earns-rs-5-15-crore-in-thailand/articleshow/135754784.cms)

#### Noel Tata retires as Tata Investment Corporation chairman

*business desk · event #661 · printed 2026-11-12 05:47 UTC · 3 independent outlets · headline 57 chars · body 45 words*

> Noel Tata has retired from his position as chairman of Tata Investment Corporation, the company he led. Bahram Vakil has taken over the role of chairman at Tata Investment Corporation. Tata has also stepped down from his other roles at various other Tata group companies.

**Fact sheet**

- **core** · Noel Tata retired as Chairman of Tata Investment Corporation. — The Tribune, Indian Express, Times of India
- **core** · Bahram Vakil succeeded Noel Tata as Chairman of Tata Investment Corporation. — The Tribune, Times of India
- **supporting** · Noel Tata stepped down from other Tata companies. — Indian Express, Times of India
- **background** · The company is Tata Investment Corporation. — The Tribune, Indian Express, Times of India
- *(left out: outlets conflict)* Noel Tata's tenure as Chairman: 16 years vs. since June 2010 — The Tribune, Times of India

**Sources**

- Indian Express (headline and feed summary only): [Noel Tata to step down as Chairman of Tata Investment Corp, 5 other Tata firms](https://indianexpress.com/article/business/noel-tata-step-down-chairman-tata-investment-corp-tata-firms-10959649/)
- Times of India: [Noel Tata passes baton to Bahram Vakil at TICL](https://timesofindia.indiatimes.com/business/india-business/noel-tata-passes-baton-to-bahram-vakil-at-tata-investment-corporation/articleshow/135756843.cms)
- The Tribune (ANI copy) (headline and feed summary only): [Noel Tata retires as Tata Investment Chairman after 16 years, Bahram Vakil to succeed him](https://www.tribuneindia.com/news/bahram-vakil/noel-tata-retires-as-tata-investment-chairman-after-16-years-bahram-vakil-to-succeed-him)

#### Air India's first-half losses decline

*business desk · event #571 · printed 2026-11-12 05:43 UTC · 3 independent outlets · headline 37 chars · body 45 words*

> Air India's first-half losses have declined, with the carrier narrowing its loss by approximately ₹2,000 crore from the prior year's figure of about Rs 12,500 crore. Singapore Airlines, which disclosed the figures, also stated that Air India has made tangible progress in its multi-year transformation.

**Fact sheet**

- **core** · Air India's first-half losses declined. — The New Indian Express, Times of India
- **supporting** · Air India's first-half losses narrowed by about ₹2,000 crore. — The Hindu, The New Indian Express, Times of India
- **supporting** · Singapore Airlines said Air India has made tangible progress in its multi-year transformation. — The New Indian Express, Times of India
- **supporting** · Singapore Airlines disclosed information about Air India's losses. — The New Indian Express, Times of India
- **background** · Air India's first-half loss in the prior year was about Rs 12,500 crore. — The New Indian Express, Times of India
- *(left out: outlets conflict)* Amount of Singapore Airlines' share of Air India's H1 losses — The New Indian Express, Times of India
- *(left out: outlets conflict)* Amount of Singapore Airlines' share of Air India's losses in the prior year period — The New Indian Express, Times of India
- *(left out: outlets conflict)* Singapore Airlines group net profit for H1 — The New Indian Express, Times of India
- *(left out: outlets conflict)* Singapore Airlines group net profit for H1 in the prior year — The New Indian Express, Times of India
- *(left out: outlets conflict)* Air India's full-year loss amount and financial year — The Hindu, The New Indian Express

**Sources**

- The Hindu (headline and feed summary only): [Air India’s losses narrow in H1 by ₹2,000 crore](https://www.thehindu.com/business/Industry/air-indias-losses-narrow-in-h1-by-2000-crore/article71689628.ece)
- The New Indian Express: [Air India’s H1 2027 losses estimated to be around Rs 10,500 crore: SIA disclosure](https://www.newindianexpress.com/business/2026/Nov/11/air-indias-h1-2027-losses-estimated-to-be-around-rs-10500-crore-sia-disclosure)
- Times of India: [Air India loss share declines but fuel bites Singapore Airlines group as H1 profit falls 44% to Rs 767 crore](https://timesofindia.indiatimes.com/business/india-business/air-india-loss-share-declines-but-fuel-bites-singapore-airlines-group-as-h1-profit-falls-44-to-rs-767-crore/articleshow/135736528.cms)

#### Sea Vigil-26 coastal defence exercise begins

*india desk · event #612 · printed 2026-11-12 05:43 UTC · 2 independent outlets · headline 44 chars · body 60 words*

> The multi-agency coastal defence exercise 'Sea Vigil-26' began on Wednesday, spanning India's entire coastline and Exclusive Economic Zone. Its fifth edition involves all coastal states and union territories, the Indian Navy, Coast Guard, coastal security police, Customs, and union ministries including Home Affairs, Shipping, and Petroleum. The exercise has two phases, including a sea phase on November 18 and 19.

**Fact sheet**

- **core** · The multi-agency coastal defence exercise 'Sea Vigil-26' began on Wednesday. — Hindustan Times, The New Indian Express
- **core** · The exercise spans India's entire coastline and Exclusive Economic Zone. — Hindustan Times, The New Indian Express
- **supporting** · The exercise is the fifth edition of the Sea Vigil coastal defence exercise. — Hindustan Times, The New Indian Express
- **supporting** · All coastal states and union territories are involved. — Hindustan Times, The New Indian Express
- **supporting** · The exercise involves the Coast Guard, coastal security police, and Customs. — Hindustan Times, The New Indian Express
- **supporting** · The Indian Navy is involved in the exercise. — Hindustan Times, The New Indian Express
- **supporting** · The exercise is conducted in two phases. — Hindustan Times, The New Indian Express
- **supporting** · The exercise includes a Coastal Defence and Security Readiness Evaluation phase. — Hindustan Times, The New Indian Express
- **supporting** · The sea phase takes place on November 18 and 19. — Hindustan Times, The New Indian Express
- **supporting** · Union ministries are involved in the exercise. — Hindustan Times, The New Indian Express
- **supporting** · The ministries involved include Home Affairs, Shipping, and Petroleum. — Hindustan Times, The New Indian Express
- *(left out: outlets conflict)* Disputed number of ministries involved: six versus five — Hindustan Times, The New Indian Express

**Sources**

- Hindustan Times (PTI copy): [Multi-agency coastal defence exercise 'Sea Vigil-26' begins](https://www.hindustantimes.com/india-news/multiagency-coastal-defence-exercise-sea-vigil-26-begins-101794404187104.html)
- The New Indian Express: [First since Operation Sindoor, Navy tests coastal security grid built after 26/11](https://www.newindianexpress.com/india/2026/Nov/11/first-since-operation-sindoor-navy-tests-coastal-security-grid-built-after-2611)

#### Firecrackers main source of Delhi air pollution, study finds

*india desk · event #294 · printed 2026-11-12 05:41 UTC · 3 independent outlets · headline 60 chars · body 56 words*

> Firecrackers were the main source of air pollution in Delhi during the period studied, according to a study by the Indian Institute of Tropical Meteorology. The research examined data from November 9, and the Central Pollution Control Board noted that its monitoring stations' analysers can measure PM2.5 concentrations only up to 1,000 micrograms per cubic metre.

**Fact sheet**

- **core** · Firecrackers were the main source of air pollution in Delhi during the period studied. — The Hindu, Hindustan Times
- **supporting** · The Indian Institute of Tropical Meteorology (IITM) conducted the study. — The Hindu, Hindustan Times
- **supporting** · The study examined air pollution data from November 9. — The Hindu, Hindustan Times
- **background** · The Central Pollution Control Board stated that its monitoring stations' analysers can measure PM2.5 concentrations only up to 1,000 micrograms per cubic metre. — Hindustan Times, Times of India
- *(left out: outlets conflict)* Whether any monitoring station recorded PM2.5 readings above 1,000 on Diwali night — Hindustan Times, Times of India
- *(left out: outlets conflict)* Total number of air-quality monitoring stations in Delhi — Hindustan Times, Times of India
- *(left out: outlets conflict)* Average AQI on the morning after Diwali — Hindustan Times, Times of India

**Sources**

- The Hindu (headline and feed summary only): [Firecrackers still Delhi’s top pollutant after Deepavali, IITM finds](https://www.thehindu.com/news/cities/Delhi/firecrackers-still-delhis-top-pollutant-after-deepavali-iitm-finds/article71688942.ece)
- Hindustan Times: [Firecrackers were responsible for 71% of air pollution on Diwali night in Delhi: Study](https://www.hindustantimes.com/india-news/firecrackers-were-responsible-for-71-of-air-pollution-on-diwali-night-in-delhi-study-101794369666825.html)
- Times of India: [Complete data could've raised average Diwali pollution level in Delhi by 49%](https://timesofindia.indiatimes.com/india/complete-data-couldve-raised-average-diwali-pollution-level-49/articleshow/135748336.cms)
