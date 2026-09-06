# The combativeness spectrum for automated web access

A reference for deciding what this project will and won't do. Ratings are from the viewpoint of a
corporate security/legal reviewer in 2026. Compiled 2026-08-28 from primary sources (RFCs, vendor
bot documentation, court decisions, Cloudflare's published norms); see Sources at the end.

Legend: 🟢 universally acceptable · 🟡 acceptable with care · 🟠 frowned upon / deceptive in effect ·
🔴 circumvention; legal exposure; no reviewer will sign off.

## Two axes, not one ladder (revised 2026-08-29)

The first version of this file was a single ladder, which quietly assumed every automated client is a
*crawler*. That conflates two things that should be judged separately:

1. **Identity — is a claim being made?** A server-side program presenting a Chrome TLS fingerprint
   (`curl_cffi`) is a lie: it asserts "I am a person's browser". A tool that opens the person's actual
   Chrome on their behalf makes no claim — it *is* their browser, like a screen reader or reader mode.
   Deception lives on this axis. Hiding `navigator.webdriver` is the same kind of lie in the other
   direction: the browser's own honest statement "I am being driven by a program" is suppressed.
2. **Behaviour — pace, harm, circumvention.** Rate, concurrency, obeying `Retry-After`, never solving a
   challenge, never rotating identity or IP after a "no", never touching private networks. This is what
   trespass-to-chattels, CFAA-after-*Van Buren* and every operator's abuse desk actually turn on.

That yields two coherent, mainstream postures — both held by serious companies:

| | **Crawler posture** | **User-agent posture** |
|---|---|---|
| Premise | a self-identifying automated client that a person triggered | the person's browser, driven on their behalf at human pace |
| Precedent | Anthropic's `Claude-User` (obeys robots.txt); Cloudflare's "well-behaved bot" norms | OpenAI's `ChatGPT-User` ("robots.txt rules may not apply"); Claude in Chrome, Playwright MCP, Browser Use and every computer-use product |
| robots.txt | honoured (RFC 9309) | not consulted — RFC 9309 addresses "automatic clients"; browsers don't read it |
| Identification | product token / `From:` header; browser tiers send the browser's own UA (`HeadlessChrome` when headless) plus `From:`/`X-Agent:` | none beyond being Chrome; `navigator.webdriver` still true |
| Challenges | final | shown to the person, who may pass them; the tool never does |
| Legal shape (US, not advice) | the "good bot" fact pattern | reading public pages is not "unauthorised access" (*Van Buren*, *hiQ*, *Meta v. Bright Data*); an engine's "no automated queries" clause is a contract term the *person* accepted — breach risk sits on their account, not in a statute |
| What is identical | pace limits, final refusals after a challenge, no stealth, no CAPTCHA solving, no proxies, no credentials held by the tool, SSRF guard, audit log | same |

fearch's own fetching is always the crawler posture; the user-agent posture exists only for engine result pages with a person present (README → *Headless until it matters*). The `--robots off` dial that once put the tool's own fetching into the user-agent posture was removed 2026-09-02. The rungs below are
still useful for the *behaviour* axis and for placing third-party tools; read rung 12 with the identity
distinction in mind.

## The rungs

| # | Technique | What governs it | Rating | Why |
|---|---|---|---|---|
| 0 | **Official API under contract** (search API, content API, licensed feed) | Contract / provider ToS | 🟢 | You are not making a unilateral access decision at all. |
| 1 | **Honest, self-identifying User-Agent with a contact URL**; obey `robots.txt` (RFC 9309) incl. `Crawl-delay`; honor HTTP 429/503 + `Retry-After`; conditional GETs (`If-None-Match`/`If-Modified-Since`); one connection per host | RFC 9309 (Robots Exclusion Protocol, Standards Track), RFC 9110 §15.5.29 | 🟢 | This is Cloudflare's published definition of a well-behaved bot: "identify themselves honestly, using a unique user-agent", "follow the rules… respecting website signals like robots.txt", never use "stealth tactics". Claude Code's own WebFetch does exactly this (`Claude-User (claude-code/x; +https://support.anthropic.com/)`). |
| 2 | **Voluntarily honor AI-specific robots tokens** (`GPTBot`, `ClaudeBot`, `Claude-User`, `Google-Extended`, `CCBot`, `PerplexityBot`) even though your UA isn't one of them | RFC 9309; EU DSM Directive Art. 4(3) machine-readable TDM opt-out | 🟢 | *Kneschke v. LAION* (OLG Hamburg, 5 U 104/24, Dec 2025) confirmed robots.txt / `X-Robots-Tag` / TDM-RP are valid machine-readable opt-outs. In the EU, ignoring them is copyright exposure, not just bad manners. |
| 3 | **Read emerging licence/preference signals**: IETF AIPREF drafts (`train-ai`, `search` categories), RSL 1.0 (Dec 2025), `llms.txt`, `noai`/`noimageai` meta, `Accept: text/markdown` content negotiation | Not yet law; consensus in progress | 🟢 | Pure upside. Not a legal shield — AIPREF isn't an RFC yet, RSL is an industry spec, `noai` is a convention. Read them, surface them, log them. |
| 4 | **Treat HTTP 402 and 403 as final** | Contract (Cloudflare Pay-Per-Crawl, Jul 2025 — AI crawlers blocked *by default* on new zones) | 🟢 | A large slice of the web now defaults to "no". A respectful client hears "no". |
| 5 | **User-initiated fetch with a declared agent** ("a human asked for this URL") | Vendor policy; no statute | 🟢 *if you still obey robots.txt* | Vendors split: **Anthropic** says all three of its agents incl. `Claude-User` honor robots.txt and `Crawl-delay`; **OpenAI** says for `ChatGPT-User` "robots.txt rules may not apply." Follow Anthropic's stricter posture — it is defensible; OpenAI's is a position, not a norm. |
| 6 | **Generic browser User-Agent on a plain HTTP client** (`Mozilla/5.0 … Chrome/124 …`), no self-identification | No statute; violates the premise of RFC 9309 and every "good bot" norm | 🟡 → 🟠 | 🟡 if incidental. 🟠 when used *as a fallback after being blocked* — that is precisely the fact pattern for which Cloudflare delisted Perplexity as a Verified Bot (Aug 2025): a declared bot got blocked, then returned as generic Chrome. The intent element is what changes the colour. |
| 7 | **Headless browser without stealth**, honest UA, for pages that only exist after JavaScript runs | Some ToS bar "automated means" | 🟡 | Legitimate for JS-only pages. Declare yourself; keep concurrency low. |
| 7b | **The person's own browser — either their installed Chrome launched with a tool profile, or their actual Chrome via a read-only extension — at human pace, with challenges handed to the person** (user-agent posture) | Contract terms the person accepted; no statute. *Amazon v. Perplexity* (9th Cir., 2026-08-04, No. 26-1444): an agent acting at the user's direction from the user's browser is a tool, the user is the accessor, and the CFAA does not reach it — expressly limited to that architecture, terms of service untouched | 🟡 | No identity claim is made (it is Chrome, `navigator.webdriver` true, infobar visible) — and no disclosure is possible either, which is why it must be the person's explicit choice. Google/Bing's "no automated queries" clauses are the person's contract, so this is their call and their account's risk; a tool must make it a visible choice (`--engines`), never a default, and never solve the challenge itself. "You press search" (`FEARCH_HUMAN_SEARCH`) is the cleanest form: the person submits each query. The same place Claude in Chrome and Playwright MCP sit. |
| 8 | **Anti-fingerprinting / stealth**: `puppeteer-extra-stealth`, patched CDP (patchright/Camoufox), `navigator.webdriver` masking, UA/header randomization, fake `Referer`/`Origin`, rotating UA pools | No statute directly; turns an access dispute into a *deception* narrative | 🟠 | Note: SearXNG "generates a random browser profile for every request" by design, so a SearXNG backend sits here too. So does `ddgs`-style scraping of search engines that publish no API. Google's ToS: no "automated queries of any sort … without express permission." |
| 9 | **TLS/JA3 fingerprint impersonation** (`curl_cffi`, `curl-impersonate`, `primp`, `wreq`, `got-scraping` TLS mode) | Argued as DMCA §1201 circumvention | 🟠 | Google v. SerpApi (filed Dec 2025) pleaded §1201 over exactly this ("masks its automated queries to appear human"). The DMCA claims were dismissed (Jul 2026) — a weak legal theory — but the largest search engine sued over it, which is the corporate-risk signal. A protocol-level lie about what software you are. |
| 10 | **Residential proxy / IP / ASN rotation to get past a block** | Contract; CFAA "without authorization" once blocked | 🔴 | CFAA is narrow after *Van Buren* (2021) and *hiQ v. LinkedIn* (9th Cir. 2022) for *public, logged-out* data — but hiQ still lost on breach of contract and *Ryanair v. Booking* went to a jury on CFAA (verdict later reversed as a matter of law). Rotation-after-block is the fact pattern that flips a judge. |
| 11 | **CAPTCHA / Turnstile solving** (services, simulated human mouse movement) | §1201 arguments; CFAA strongest here; provider ToS | 🔴 | Solving a challenge the operator erected to say "no" is unambiguous circumvention of an access control, whatever the DMCA outcome. |
| 12 | **Session forgery, credential sharing, scraping behind someone else's login** | CFAA §1030 (the "off-limits area" *Van Buren* preserved); possibly SCA | 🔴 potentially criminal | *Meta v. Bright Data* (N.D. Cal. 2024) turned entirely on the scraper being *logged off*. Log in and you are a "user", bound by clickwrap ToS, inside an authenticated area. **Distinguish:** a person reading content they are entitled to (their own subscription, their own repo) through a tool they run, in a profile only they populated, is that person using their account — a ToS question at most (rung 7b), not §1030. The 🔴 is for sessions the person did not create or is not entitled to. |

### The contract layer (orthogonal to the rungs)

Clickwrap ("I agree") is generally enforceable; browsewrap (a footer link) often isn't (*Berman v.
Freedom Financial*, 9th Cir. 2022). *Meta v. Bright Data* (N.D. Cal., Jan 2024) held that a platform's
terms bind an account holder using the account and do not reach **logged-off** reading of public pages;
*X Corp. v. Bright Data* (N.D. Cal., May 2024) dismissed X's ToS scraping claims as **preempted by the
Copyright Act**, limiting ToS-as-scraping-ban; *hiQ* itself ended with summary judgment for LinkedIn on
breach of its User Agreement (Nov 2022) and a $500,000 consent judgment — the CFAA point was won, the
contract point lost. For this tool the practical reading is: whether the person's *account* is in the
picture is what decides whether an engine's terms bind that query, which is why `--incognito` for engine
pages is a legal lever as well as a privacy one. These are US district/circuit decisions, not settled law,
and none are EU/UK law; the UK has no commercial TDM exception.

## Where this project's versions sit

| | v1 (Python; removed from the tree, in git history) | v2 (TypeScript, `packages/core`) |
|---|---|---|
| Identity | `curl_cffi` **Chrome TLS impersonation** (rung 9) | Honest UA with contact (rung 1) |
| robots.txt | not read | honored by default for `*`, own token, and the user-initiated agent tokens (`Claude-User`, `ChatGPT-User`); training-crawler opt-outs under `strict` (rungs 1–2); `Crawl-delay`; re-checked on cross-host redirects |
| On a block / JS shell | automatic fallback to `r.jina.ai` then Wayback (rung 6-style intent; third-party egress) | one attempt in a real headless Chromium that identifies itself (rung 7, no stealth); if that is refused too, **final** with a diagnosis listing both attempts (rung 4) |
| Search | `ddgs` undeclared SERP scraping (rung 8–9) | DuckDuckGo lite in a real browser window, never headless (rung 7b; its robots.txt permits it); Google result pages only when listed in `--engines` and a person is present overseeing a visible browser or their own Chrome (rung 7b); no third-party search services, no keyed adapters, no hidden fallback (the first-party API federation, Bing and the robots-off posture were removed 2026-08-31 / 09-02) |
| Visible window / extension / human handoff | – | opt-in: installed Chrome with a tool profile, or the person's own Chrome through the read-only fearch bridge extension (no automation signals at all — the one tier where "not blocked" and "not pretending" coincide), challenges handed to the person (rung 7b); the person's own cookies reach engine pages only (never ordinary reads), always labelled, `--incognito` keeps them out |
| Scraping | built in, default | none. An opt-in impersonation module existed briefly and was removed on 2026-08-29: the visible-window tier covers the personal-use case without lying about what the client is |
| Verdict | personal use; **orange** | defaults: corporate-safe, **green core + yellow browser tier** — the same place ordinary Playwright/Puppeteer automation sits. User-agent posture: **yellow, the person's explicit choice**, stamped on every result |

## What the vendors' own documentation says (verified 2026-09-02; quotes in RESEARCH-RECONCILIATION, Report F)

| Vendor product | Where it runs | Person's sessions | Identifies itself to sites | Bot checks | Uses a search engine on the person's behalf |
|---|---|---|---|---|---|
| Microsoft Copilot Cowork (local browser) | a **hidden tab** in the person's own Edge | yes ("no more and no less" than the person) | not described | hands the tab to the person | not described |
| Anthropic Claude in Chrome | new tabs in the person's own Chrome, visible | yes ("shares your browser's login state") | not described | "pauses and asks you to handle it manually" | by example (types into a site's search box) |
| Google Gemini in Chrome / auto browse | the person's own Chrome | yes | not described | not described | yes — "automatically uses … Google Search, Google Maps, YouTube" |
| Perplexity `Perplexity-User` | Perplexity's servers (a fetcher, not a browser) | no | yes (UA + IP ranges) | n/a | n/a; "generally ignores robots.txt" for user requests |
| OpenAI cloud browser / Operator | OpenAI's servers | no (cloud profile) | yes (RFC 9421 signatures; verified on OpenAI's help page) | "Takeover Mode": the person | in the browser, as a person would |
| **fearch** | plain HTTP self-identified and robots-governed; the person's own Chrome (extension) or a visible window only for a check | extension: yes unless `--incognito`; headless: never | plain HTTP and Playwright tiers: yes; extension: no (it is the person's Chrome) | handed to the person; never solved | DuckDuckGo automatically; Google only if listed, and with `--human-search` the person submits |

The local-browser row is the norm fearch's extension tier sits in; where fearch differs it is stricter.

## Indexes, not models

fearch reads indexes and pages. A generated answer is surfaced only when it comes attached to a
results page the person opened — Google's AI Overview, Web Guide summary, or AI Mode reply — and it
is labelled as the engine's unverified text with the pages it cites. fearch never converses with a
model as a source: one question per call, no thread, no follow-up. Chat products are models, not
indexes: Duck.ai's terms forbid "automated querying and developing or offering AI services"
(read 2026-09-06); Anthropic's consumer terms forbid access "through automated or non-human
means" outside the API (read 2026-09-06); OpenAI's and Google's consumer terms point agents to
their APIs. A person may chat with any of them and paste the reply into a model; the automation is
what those clauses name, so fearch does not build it.

## Search providers by posture

| Provider | Index provenance | Free tier | Key | Posture |
|---|---|---|---|---|
| Exa hosted MCP (`mcp.exa.ai`) | Exa's own (LLM-native; SERP layer undisclosed) | yes, "casual use", 429 when heavy | none | 🟢 vendor's own keyless offering |
| GitHub / StackExchange / npm / crates.io / MDN / Wikipedia search APIs | first-party | yes | none (GitHub code search needs a token) | 🟢 |
| Brave Search API | own index | $5/mo credit, card required (free tier removed Feb 2026) | yes | 🟢 cleanest ToS; storage rights need a plan |
| Mojeek API | own independent index | ~2,000/mo | yes (by request) | 🟢 smaller index; LLM-use terms unverified |
| Anthropic `web_search` (server-side) | upstream index, undisclosed | no ($10/1k) | yes | 🟢 licensed |
| Tavily / Exa (keyed) / Linkup / Parallel | mixed own crawl + licensed; SERP layer undisclosed | small free tiers | yes | 🟢/🟡 ask vendor in writing about scraped layers |
| Perplexity Search API | own | no ($5/1k) | yes | 🟡 the company Cloudflare delisted for stealth crawling; reviewers will raise it |
| Google Programmable Search | Google | 100/day | yes | closed to new customers; shuts down 2027-01-01 |
| Serper / SerpApi / DataForSEO | **scraped Google SERPs** | some | yes | 🔴 reseller of rung 8–9 behaviour; SerpApi is a named defendant |
| DuckDuckGo lite in a real browser window (the person's Chrome, or a background window of the installed Chrome) | Bing-syndicated | yes | none | 🟡 rung 7b: robots.txt permits `/lite/`; ToS has no automation clause; DDG's bot-check (it keys on the User-Agent — `HeadlessChrome` and token-bearing UAs get it, a real Chrome window does not; measured 2026-09-03) is put to the person to pass, never to the tool |
| Google result pages in the person's browser, challenges handed to the person | own index | yes | none | 🟡 rung 7b: `Disallow: /search` and ToS clauses are the person's contract under the user-agent posture; Google's check is IP-level and only a person can pass it; opt-in via `--engines`, never a default. (Bing sat here too until 2026-09-02; removed — decoy results to automated browsers.) |
| Google with `--human-search` | own index | yes | none | 🟢/🟡 each query shown to the person, editable, run only on their accept (or submitted by them in the browser); the tool only reads the page they landed on |
| Google AI Mode (`google-ai`) in the person's browser | own index through Google's model | yes | none | 🟡 rung 7b, same as Google result pages: opt-in, approved per query, incognito default; the reply is labelled as Google's unverified text, its citations are the results; one question per call, never a conversation |
| `ddgs`, SearXNG, DDG/Bing HTML scraping with impersonation | scraped | yes | none | 🟠 browser impersonation required to work |
| Google / Bing / Brave / Mojeek / Startpage result pages by a server-side client or a stealth browser | scraped | yes | none | 🟠→🔴 `Disallow: /search` for all agents; ToS forbid automated queries; hiding `navigator.webdriver` / TLS impersonation is the identity lie |

## The respectful-fetch checklist (what v2 implements)

1. `User-Agent: fearch/<ver> (+<info URL>; <contact>)` — never a browser string, not configurable to one.
2. Fetch and cache `/robots.txt`; match own token, `*`, and AI-agent tokens; fail closed on 401/403/parse errors; honor `Crawl-delay`.
3. ≥1 s between requests to a host; 1 connection per host; obey a short 429/503 `Retry-After` exactly, once; a persistent 403 is final.
4. Conditional requests with ETag/Last-Modified; on-disk cache; `Accept-Encoding: gzip`.
5. `Accept: text/markdown, text/html;q=0.9`; try `llms.txt` / `.md` variants; use official APIs (GitHub, PyPI, npm, StackExchange, arXiv) instead of HTML where they exist.
6. Read and surface `X-Robots-Tag`, `noai`, RSL/AIPREF signals alongside the content.
7. Never: stealth, TLS impersonation, proxy rotation, CAPTCHA solving, cookie injection, credentials held by the tool, silent third-party fetch proxies. (The tool-owned profile holds only what the person did in windows the tool opened; it is sent to engine pages, never to ordinary reads, with no dial to change that.)
8. Refuse private/loopback/link-local/metadata targets; re-validate every redirect hop.
9. Audit log every request (URL, time, status, robots decision, bytes); domain allow/deny lists; no telemetry.
10. Attribute: keep source URL and retrieval time; quote sparingly.

## Sources

- Cloudflare, "Perplexity is using stealth, undeclared crawlers to evade website no-crawl directives" (Aug 2025) — https://blog.cloudflare.com/perplexity-is-using-stealth-undeclared-crawlers-to-evade-website-no-crawl-directives/
- Cloudflare, "Introducing pay per crawl" (Jul 2025) — https://blog.cloudflare.com/introducing-pay-per-crawl/
- RFC 9309, Robots Exclusion Protocol — https://www.rfc-editor.org/rfc/rfc9309
- Anthropic, "Does Anthropic crawl data from the web…" (ClaudeBot / Claude-User / Claude-SearchBot) — https://support.claude.com/en/articles/8896518
- OpenAI, "Overview of OpenAI crawlers" (OAI-SearchBot / ChatGPT-User / GPTBot) — https://developers.openai.com/api/docs/bots
- IETF AIPREF working group — https://www.ietf.org/blog/aipref-wg/ ; vocabulary draft — https://ietf-wg-aipref.github.io/drafts/draft-ietf-aipref-vocab.html
- RSL 1.0 — https://rslstandard.org/rsl ; llms.txt — https://llmstxt.org/
- *Kneschke v. LAION*, OLG Hamburg (Bird & Bird summary) — https://www.twobirds.com/en/insights/2025/germany/higher-regional-court-hamburg-confirms-ai-training-was-permitted-(kneschke-v,-d-,-laion)
- *hiQ v. LinkedIn* (Jenner & Block) — https://www.jenner.com/en/news-insights/publications/client-alert-data-scraping-in-hiq-v-linkedin-the-ninth-circuit-reaffirms-narrow-interpretation-of-cfaa
- *Meta v. Bright Data* (Quinn Emanuel) — https://www.quinnemanuel.com/the-firm/news-events/client-alert-meta-v-bright-data-significant-decision-for-web-scraping-industry/
- *X Corp. v. Bright Data* (Skadden) — https://www.skadden.com/insights/publications/2024/05/district-court-adopts-broad-view
- *Ryanair v. Booking.com* verdict and reversal (Bloomberg Law) — https://news.bloomberglaw.com/litigation/booking-com-wins-reversal-of-verdict-for-ryanair-scraping-case
- Google v. SerpApi (IPWatchdog, Dec 2025) — https://ipwatchdog.com/2025/12/26/google-sues-serpapi-parasitic-scraping-circumvention-protection-measures/ ; DMCA claims dismissed (PPC Land, Jul 2026) — https://ppc.land/google-loses-dmca-bid-to-treat-search-scraping-like-dvd-piracy/
- *Amazon.com Services, LLC v. Perplexity AI, Inc.*, No. 26-1444 (9th Cir. Aug. 4, 2026) — https://cdn.ca9.uscourts.gov/datastore/opinions/2026/08/04/26-1444.pdf ; Ropes & Gray summary — https://www.ropesgray.com/en/insights/alerts/2026/08/tool-or-intruder-what-amazon-v-perplexity-means-for-agentic-ai-and-the-cfaa
- Bing Search API retirement (Aug 2025) — https://learn.microsoft.com/en-us/lifecycle/announcements/bing-search-api-retirement
- Brave Search API pricing — https://brave.com/search/api/ ; free tier removal — https://www.implicator.ai/brave-drops-free-search-api-tier-puts-all-developers-on-metered-billing/
- Exa hosted MCP (keyless "casual use") — https://exa.ai/docs/reference/exa-mcp
- SearXNG, "Why use a private instance" (random browser profiles) — https://docs.searxng.org/own-instance.html
- Claude Code source: `docs/references/repos/claude-code-main/src/tools/WebFetchTool/utils.ts`, `src/utils/http.ts:56`
