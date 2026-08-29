# Research prompt: reading the public web from a coding assistant — free, honest, no keys

Copy everything below the line into the research agent.

---

## The problem, plainly

Coding assistants (Claude Code, Cursor, OpenCode, Cline and similar) need two things from the web: **find pages** (search) and **read pages** (fetch a URL and get its text). Some assistants ship this built in; many don't, or lock it behind a paid plan. I'm building a small open-source tool, run locally on a developer's own machine, that provides both to any assistant.

What it must be:

- **Free, with no keys and no sign-ups.** It has to work out of the box, the way a developer opening a browser tab works. Asking users to obtain an API key defeats the purpose.
- **Honest and corporate-safe.** I want to be able to run it at work without anyone getting in trouble. It identifies itself truthfully, respects sites that say no, goes slowly, and never does anything subversive: no browser-fingerprint or TLS spoofing, no CAPTCHA solving, no proxy or identity rotation, no cookies or logged-in access, no routing pages through third-party "reader" services. Ordinary browser automation (a real headless Chromium that says what it is) is acceptable — that's normal corporate practice.
- **Low volume.** One developer, tens of requests per hour, bursty. Not crawling, not harvesting, not training. It reads the specific pages a person asked about.

Typical use: read framework and API documentation, GitHub repositories/issues/files, package registry pages, Q&A threads, blog posts, PDFs; and find those pages in the first place.

## What I want from you

Investigate the problem broadly and tell me how this *should* work in 2026. Treat my own current choices (in the appendix at the end) as context, not as the question — I got a previous report that mostly graded the examples I happened to mention, and it missed the fundamentals. Prefer primary sources (terms of service, robots.txt files, official developer docs, standards drafts, vendor blog posts), give retrieval dates, mark confidence, and be blunt where the honest answer is unfavourable to what I'm doing. Include a final section titled **"Things you didn't ask but should know."**

## Part 1 — The fundamentals (answer these first, open-mindedly)

1. **How readable is the public web for an honest, self-identified, non-browser client today?** For the kinds of sites a developer reads (documentation platforms, GitHub, package registries, Q&A sites, engineering blogs on common hosts, academic PDFs), roughly what share serves a plain HTTP GET with an honest product User-Agent, what share needs JavaScript, and what share blocks unknown automated clients outright? Any measured data (studies, crawler operators' reports, CDN statistics) is far more valuable than anecdotes.
2. **Where are the walls, and why?** Which layers block (CDN bot management such as Cloudflare/Akamai/Fastly/Vercel, hosting-platform defaults, site-level rules), what signals they use, and — importantly — whether they distinguish "unknown but honest low-volume agent" from "scraper." What changed in 2025–2026 (e.g. CDNs blocking AI agents by default)?
3. **What do the major players consider acceptable for user-initiated reading?** Compare the published positions of Anthropic, OpenAI, Google, Perplexity, Microsoft, Cloudflare and standards bodies (IETF robots/AIPREF work, robotstxt.org) on: robots.txt applying to a fetch a human asked for; identification requirements; rate expectations; what counts as evasion. Where do they disagree, and which position would a corporate security/legal reviewer expect a third-party tool to follow?
4. **Is a search engine even the right primitive?** For a coding assistant, are there better keyless ways to *find* pages than general web search — documentation indexes and directories (llms.txt aggregators, docs sitemaps), site-specific search endpoints that are meant to be public, package-registry and code-host search, curated indexes? What do the best-regarded assistants actually do for discovery today, and what does that cost them?
5. **Is there a recognised path for a well-behaved agent to be let in rather than blocked?** Investigate Cloudflare's *Web Bot Auth* (signed requests) and *BotBase / Verified Bots* directory, and any equivalents at other CDNs or in IETF drafts: can an open-source tool that runs on end users' machines (no fixed IP ranges) register and be recognised? Requirements, cost, process, and what it buys. What do `Claude-User` / `ChatGPT-User` get that a third-party agent does not?

## Part 2 — Plain fetching (reading a URL) in depth

6. For an honest client, what concretely maximises success without deception: `Accept: text/markdown` negotiation (which platforms honour it — please produce a list with sources), `llms.txt` and `.md` variants, HTTP conditional requests, retry/backoff behaviour on 429/503, following the site's `Crawl-delay`? Which documentation platforms (Mintlify, GitBook, Docusaurus, MkDocs, Sphinx/Read the Docs, VitePress, Fern, Vercel, Cloudflare, Microsoft Learn, AWS, Google Cloud, Apple, Atlassian Confluence public spaces, Notion public pages) can be read with plain HTTP, which need JavaScript, and which block automation entirely?
7. **The headless-browser question.** If a plain fetch is refused or returns a JavaScript-only shell and the tool opens the page once in a real headless Chromium that identifies itself (its own User-Agent plus a product token appended), how is that treated by major bot-management systems and by site operators' stated policies? Is appending a product token to the browser UA more or less likely to trigger a block than leaving it stock? Is a stock "HeadlessChrome" UA itself a block signal? Is there any published guidance on *honest* headless use (Playwright/Puppeteer without stealth) versus stealth use?
8. **Refusals.** What is the respectful, defensible behaviour after a 403, a challenge page, a paywall or a login wall? Is trying once more with a browser considered evasion by anyone credible? What should the tool tell the user?
9. **Archived copies.** Reading an Internet Archive (Wayback) copy of a page that now returns 404/410, only on explicit request: what do the Internet Archive's terms and rate policies say about automated access?
10. **PDF and non-HTML content**: any terms or etiquette specific to fetching PDFs from arXiv, publishers, standards bodies, government sites.

## Part 3 — Finding pages without a key

11. Produce a complete, sourced survey of **keyless search or discovery services that permit programmatic use**, with exact limits and terms: independent/non-profit engines (Mwmbl, Stract, Marginalia, Mojeek, Kagi Small Web, YaCy peers), hosted developer endpoints offered without a key (Exa's public MCP endpoint — get its real limits and whether building a tool on it is permitted; Jina; Parallel; Linkup; Tavily; You.com; Perplexity), archive/index APIs (Common Crawl CDX and any full-text search over it, Internet Archive), knowledge APIs (Wikipedia/Wikidata, Semantic Scholar, arXiv, OpenAlex), community/dev APIs (Hacker News Algolia, dev.to, Hashnode, Lobsters), code/package search (GitHub, GitLab, npm, PyPI, crates.io, Maven Central, RubyGems, pkg.go.dev, docs.rs), and no-JavaScript search-engine result pages (DuckDuckGo lite/html, Qwant lite, Yahoo, Ecosia, Yandex, Baidu). For each: keyless? limits? does the ToS permit automated queries from a self-identified tool? does robots.txt permit the endpoint? first-party index or reseller of scraped results? result quality for technical queries? For DuckDuckGo specifically: robots.txt allows `/lite/` and `/html/` but the site serves a bot-check to non-browsers — what do DuckDuckGo's Terms of Service / Acceptable Use Policy actually say about low-volume automated queries, and is there any stated position on identified clients or on real browsers driven by automation?
12. Rank the realistic options for (a) general questions and (b) developer questions, and state plainly if the honest conclusion is *"there is no reliable keyless general-web search in 2026 without scraping a search engine — here is the least-bad option."*
13. **Privacy.** Any keyless hosted service receives users' queries. What do the candidates' privacy policies say about logging and retention, and what would a corporate reviewer want disclosed?

## Part 4 — Terms of the first-party APIs a tool like this leans on

14. For each: official rate limits without authentication, User-Agent or contact requirements, attribution or licensing obligations for displaying excerpts, and anything a reviewer would flag — GitHub REST search, StackExchange API (CC BY-SA attribution when showing excerpts?), npm registry search, PyPI JSON API, crates.io (its crawler policy requires contact info in the User-Agent — does a URL satisfy it?), Wikimedia (User-Agent policy: is `product/version (+URL)` without an email compliant?), MDN's site-search endpoint (supported public API or internal?), Semantic Scholar, Hacker News Algolia, arXiv, OpenAlex, docs.rs, pkg.go.dev.

## Part 5 — Legal and etiquette baseline (brief)

15. A short, current map of what is universally acceptable versus legally risky for reading public pages with an honest client, in the US and EU: robots.txt as a norm vs law, contract/ToS enforceability for logged-out reading, the EU machine-readable opt-out (applies to training, not reading?), and recent decisions or disputes (hiQ, Bright Data cases, Google v. SerpApi, Cloudflare v. Perplexity). Keep it to what changes design decisions.

## Output format

Tables where possible: option · keyless? · limits · ToS position · robots position · quality · first-party vs reseller · source URL · date checked · confidence. Then prose recommendations: the architecture you would build under these constraints, with expected reliability, and the top three things you would change about the current design in the appendix. Completeness over brevity.

---

## Appendix — current design, for context only (do not anchor on it)

- Two tools: `search` and `fetch`; output as markdown.
- Identity: `fearch/2.0 (+bot-info URL)`; robots.txt honoured for `*`, our token, and the user-initiated agent tokens `Claude-User`/`ChatGPT-User`, but **not** training-crawler tokens (`GPTBot`, `CCBot`, `Google-Extended`) on the reasoning that we don't train — I would like this challenged.
- Politeness: one connection per host, ≥1 s gap, `Crawl-delay`, 60 page fetches per 10 minutes per session, conditional requests, 24 h cache.
- Fetch ladder: plain honest GET → if refused or JavaScript-only, one self-identified headless Chromium attempt → if refused again, final, with a structured explanation. Documented public APIs (GitHub, npm, PyPI, StackExchange…) used instead of HTML where they exist.
- Search: Exa's public keyless MCP endpoint as default (rate-limits after a few dozen queries/hour), with keyless first-party APIs (GitHub, StackExchange, npm, crates.io, MDN, Wikipedia) as the fallback and for typed searches.
- Known facts already verified: Brave Search API free tier removed (Feb 2026); Bing Search APIs retired (Aug 2025); Google Programmable Search closed to new customers; Google/Bing/Brave/Mojeek/Startpage `Disallow: /search` for `*`; DuckDuckGo allows `/lite/` and `/html/` in robots.txt but serves a bot-check page to non-browser clients; Bing serves decoy results to detected non-browsers; Cloudflare blocks AI crawlers by default on new zones since July 2025 and delisted Perplexity for stealth crawling in August 2025.
