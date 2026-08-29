# Learnings from the reference implementations

What each project in `docs/references/repos/` actually does, how it does it, and what we took from it.
This is about implementation ideas, not the ethics ranking — that's `SPECTRUM.md`. File references are
into the downloaded copies. Compiled 2026-08-28.

Reading order if you only read three: **Claude Code** (the honest baseline), **CC-Web-MCP** (refusal as a
feature), **master-fetch** (the most engineered — learn from its envelope and focus mode, not its evasion).

---

## Claude Code — `claude-code-main/src/tools/WebFetchTool`, `WebSearchTool`

**What it is.** Anthropic's own client-side fetch (axios + Turndown + Haiku summarization) and a thin
wrapper over their server-side `web_search` tool.

**How it works, concretely.**
- `utils.ts:272-282` — a plain `axios.get` with `maxRedirects: 0`, `Accept: text/markdown, text/html, */*`,
  and `User-Agent: Claude-User (claude-code/<ver>; +https://support.anthropic.com/)` (`src/utils/http.ts:56`).
  The comment explains the token is "what site operators match in robots.txt".
- `utils.ts:212-243` — redirects are followed only within the same host (or a `www.` toggle); anything
  else is returned to the model as a `REDIRECT DETECTED` message with the target URL (`WebFetchTool.ts:227`).
  Their product-security review's reasoning is in the comment: open redirects on trusted domains.
- `utils.ts:176-203` — a preflight `GET api.anthropic.com/api/web/domain_info?domain=` before every new
  host, cached 5 min, with `skipWebFetchPreflight` for locked-down enterprises. Policy lives server-side.
- `utils.ts:106-128` — limits: 2,000-char URLs, 10 MB body, 60 s timeout, 10 hops, 100k-char markdown
  cap, 15-min/50 MB LRU cache. Credentials in URLs rejected (`utils.ts:156`).
- `preapproved.ts` — ~100 documentation hosts that skip the permission prompt; and if such a host returns
  `text/markdown` under 100k chars the raw markdown is handed to the model without summarization
  (`WebFetchTool.ts:264-269`). Everything else goes through Haiku with a 125-character quote limit
  (`prompt.ts:30-34`).
- `utils.ts:479-486` — binary responses (PDFs) are persisted to disk and the path returned, so the model
  can inspect the file with other tools.
- `WebSearchTool.ts:168-193` — search availability is gated by *provider*: first-party API, Vertex
  (Claude 4+), Foundry; not Bedrock. Search itself is `web_search_20250305`, a server tool.

**Insights.**
1. Being blockable is the whole identity story. No robots.txt parser in the CLI at all — the declared
   token plus a server-side blocklist is the mechanism, and when a site blocks it, the tool just fails.
2. "Return the redirect, don't follow it" is a security design, not a politeness one — worth knowing
   before copying. We follow cross-host redirects but re-validate each hop (`fetch/transport.ts`).
3. The preapproved-docs-plus-markdown shortcut is why Claude Code feels fast on docs sites: it is the
   `Accept: text/markdown` negotiation, applied only where they trust the source.
4. Summarizing with a small model is *lossy by design* and they say so; the `web-fetch` subagent they
   added later exists to get raw content back. We chose raw markdown + `focus` instead of an LLM.

**Taken:** UA convention, Accept header, size/time/hop caps, credential rejection, binary handling idea.
**Not taken:** Haiku summarization (needs a model call; lossy), same-host-only redirects.

---

## mcp-fetch (kazuph) — `mcp-fetch/index.ts`

**What it is.** A single-file TypeScript fetch server (native `fetch`, jsdom, Readability, Turndown) that
is the only one in the set that is fully honest.

**How it works.**
- `index.ts:412-413` — `User-Agent: ModelContextProtocol/1.0 (Autonomous; +https://github.com/modelcontextprotocol/servers)`.
- `index.ts:840-879` — `checkRobotsTxt` with `robots-parser`, **on by default**, size-capped at 100 KB,
  401/403 on robots.txt treated as disallow; opt-out only via `--ignore-robots-txt` or
  `security.ignoreRobotsTxt`.
- `index.ts:116-164` — `isSafeUrl` resolves *all* A/AAAA records and blocks private v4/v6, `localhost`,
  `.local`; `index.ts:190-229` — `safeFollowFetch` handles redirects manually and re-validates each hop
  (max 3).
- `index.ts:473-565` — a zod schema that accepts a legacy flat API *and* a nested API side by side; every
  numeric field is `z.union([z.number(), z.string()]).transform(Number)` because models send strings.
- Images: downloaded with `sharp`, merged vertically, exposed as MCP **resources** with `listChanged`
  notifications (`index.ts:294-304`), and written to disk instead of base64 unless asked.
- `index.ts:1348-1352` — the truncation footer tells the model exactly which `startIndex` /
  `imageStartIndex` to pass next.

**Insights.**
1. Robots-on-by-default is a ~40-line feature. Nobody else did it, which says more about culture than
   difficulty.
2. Per-hop redirect validation is the difference between "has an SSRF guard" and "actually safe" — most
   servers validate the first URL and then let `fetch` follow redirects anywhere.
3. Be tolerant of model-typed arguments (`"10"` for `10`). Cheap, avoids a whole class of tool errors.
4. Bug worth remembering: `index.ts:1047` computes "remaining characters" on the raw HTML while returning
   markdown, so its continuation hint is wrong on every HTML page. Measure what you emit.

**Taken:** robots default + fail-closed, per-hop revalidation, explicit continuation footer, string-tolerant
inputs (zod coercion in `server.ts`).
**Not taken:** image pipeline (out of scope), MCP resources (revisit for PDFs).

---

## fetch-mcp (zcaceres) — `fetch-mcp/src`

**What it is.** TypeScript, native `fetch`, six format-specific tools, a CLI twin.

**How it works.**
- `src/types.ts:9-15` — one shared schema: `url, headers, max_length (default 5000), start_index, proxy`.
- Tools per output format: `fetch_html`, `fetch_markdown`, `fetch_txt`, `fetch_json`, `fetch_readable`,
  `fetch_youtube_transcript` (shells out to `yt-dlp` if present, `src/Fetcher.ts:203-237`).
- `src/Fetcher.ts:19-53` — protocol allowlist + `private-ip` + bracketed-IPv6 unwrap + DNS check; re-run
  after the fetch completes (`Fetcher.ts:81-84`) — but `fetch` has already followed redirects by then, so an
  intermediate private hop *is requested* before being rejected.
- `src/Fetcher.ts:90-119` — `content-length` pre-check plus an incremental streaming byte cap (10 MB).
- Hardcoded Chrome 120 UA (`Fetcher.ts:66-67`); no timeout on the HTTP path; `proxy` is Bun-only and
  silently ignored on Node (`Fetcher.ts:70-71`).
- March 2026 commit history is a security sweep: SSRF, size limits, shell-injection removal.

**Insights.**
1. Format-per-tool is very legible to a model ("I want readable text" vs "I want the JSON") but costs
   tool-definition tokens; we kept one `fetch` with `raw` and content-type detection instead.
2. The streaming byte cap is the right shape (abort mid-download), and we copied it (`readCapped` in
   `fetch/transport.ts`).
3. Post-hoc SSRF checks are a trap; validate *before* each hop.
4. Ship a CLI entrypoint next to the MCP entrypoint — trivial and makes debugging painless (we have
   `dev` via tsx; a proper CLI is a good follow-up).

**Taken:** streaming byte cap, `start_index`/`max_length` naming, DNS-resolved SSRF.
**Not taken:** per-format tools, browser UA, yt-dlp.

---

## fetcher-mcp (jae-jae) — `fetcher-mcp/src`

**What it is.** Playwright-only fetcher (Readability + Turndown + GFM), HTTP/SSE transport, Docker.

**How it works.**
- `src/services/browserService.ts:32-47` rotates seven real browser UAs; `:66-112` injects an init script
  that overrides `navigator.webdriver`, deletes ChromeDriver `cdc_*` markers, fakes `window.chrome`,
  plugins, screen and languages; `:139-149` launches with `--disable-blink-features=AutomationControlled`.
- `src/services/webContentProcessor.ts:30-55` — on navigation timeout it still harvests whatever loaded
  ("timeout salvage") rather than failing.
- `browserService.ts:117-128` — blocks images/CSS/fonts for speed (`disableMedia`).
- `src/tools/fetchUrl.ts:14-69` — `waitUntil`, `waitForNavigation` (documented as useful for "anti-bot
  verification", i.e. a CAPTCHA wait), `maxLength` **default 0 = unlimited**, naive `substring` truncation
  with no continuation.
- `src/utils/urlValidator.ts:16,45` — validates the protocol only. A JS-enabled browser with no private-IP
  block is the worst SSRF surface in the set. `ignoreHTTPSErrors: true`.
- `browser_install` tool spawns `npx playwright install` from a tool call (`browserInstall.ts:110-149`).
- README documents a manual-login path: run in debug mode, log in by hand, reuse cookies.

**Insights.**
1. The popular things here are the *browser* features: `waitUntil`, resource blocking, timeout salvage,
   self-heal install. If we ever add a headless mode, that is the feature list — implemented *without*
   the stealth init script.
2. "Unlimited by default" plus `Promise.all` over a URL list is how a fetch tool floods a context window
   and a target server at the same time.
3. A tool that installs binaries on request is a supply-chain and permission problem; keep installation
   out of the tool surface.

**Taken:** nothing directly; the headless feature list is noted for a future opt-in package.
**Not taken:** all of the stealth, unlimited defaults, in-tool installs.

---

## master-fetch / "Hound" (Python) — `master-fetch/src/master_fetch`

**What it is.** The most engineered project here: 15.8k LoC, 763 tests, `primp` TLS impersonation,
`patchright`, Turnstile solver, trafilatura extraction, PDF+OCR, SQLite cache, ten scraped engines.

**How it works (the parts worth learning from).**
- `envelope.py` — every response is a structured envelope: `content_ok`, `page_type`, `content_age_days` /
  `is_stale`, `source_type` / `is_official`, `quality_score`, `is_truncated`, `next_action`. The model
  branches on fields, not prose.
- `focus.py` + `server.py:2896-2899` — `focus` returns the BM25-most-relevant paragraphs for a query.
  This is the origin of our `focus=`; we rank heading sections rather than paragraphs so code blocks stay
  attached to their explanation.
- `pdf_extractor.py:1-40` — pdfplumber for text/tables, pypdfium2 for the outline → `table_of_contents`,
  automatic OCR (rapidocr) for CID-corrupted pages, with an honest `quality_score`.
- `security.py` — best SSRF list in the set: scheme denylist, all private/reserved v4+v6, cloud-metadata
  hostnames, and DNS-rebinding suffixes (`nip.io`, `sslip.io`, `1u.ms`). We copied the suffix idea.
- `cache.py` — SQLite with TTL and a 10k-entry cap; `crawl.py:521` — crawl concurrency capped at 5.
- `scripts/count_tooldef_tokens.py` — they measure the token cost of their tool definitions and
  hand-write compact schemas (`server.py:2884-2970`).
- The parts not to learn from: `fetcher.py:349-388` (primp `impersonate="chrome"`, `referer:
  https://www.google.com/` on every request), `browser.py:189-360, 734-800` (Turnstile solver with Bézier
  mouse paths and randomized dwell), `browser.py:596-650` (webdriver/canvas/UA patching),
  `search_proxy.py` (proxy rotation "so no single address gets rate-limited"), and `robots.py` being
  present but **off by default** (`server.py:2346`) with a `next_action` that tells the model how to turn
  it off (`server.py:535`).

**Insights.**
1. A structured envelope beats prose for agent branching. We adopted the idea as the `Diagnosis` block
   and the `Robots:` / `Licence:` / `Chars a–b of N` header lines — text, but with fixed keys.
2. Query-focused extraction is the single biggest token saver in the space; do it without an LLM.
3. Measure tool-definition tokens. Ours are two tools with ~1.2k tokens of description; Playwright MCP's
   are 14k.
4. Freshness matters: `content_age_days` / `is_stale` from `Last-Modified` or dates in the page is a
   cheap, valuable signal we have not implemented yet.
5. Everything evasive in Hound is *reactive to being blocked*. The engineering is impressive and the
   direction is wrong for a corporate tool; the repo's own gotchas table says users still hit walls.

**Taken:** `focus`, envelope-style fixed header keys, SSRF rebinding suffixes, SQLite cache with TTL,
bounded batch concurrency.
**Not taken:** TLS impersonation, referer spoofing, Turnstile solving, fingerprint patching, proxy rotation,
robots-off default. **To consider:** `is_stale`/content age; PDF outline as a TOC.

---

## CC-Web-MCP (JcDizzy, Python) — `CC-Web-MCP/src/cc_web_mcp`

**What it is.** Gives Claude Code's *third-party* models (DeepSeek/Qwen/Kimi) the `WebSearch`/`WebFetch`
they lack, while telling official Claude models not to use it (`server.py:14-20`). httpx + bs4 +
markdownify; DDG/Bing/SearXNG/Mojeek/custom search; Chinese docs.

**How it works.**
- `docs/security.md` — an explicit policy: for suspected anti-scraping pages the tool "only diagnoses and
  degrades; it does not attempt to bypass access controls". `docs/capabilities.md`: TLS fingerprint
  randomization "not enabled by default".
- `web.py:2005-2053` — `_diagnose_fetch_response` classifies the wall (`captcha_or_challenge`,
  `blocked_or_waf`, `login_required`, `js_required`) and returns `retryable`, `do_not_retry_reason`,
  `recommended_next_action`. **This is the best single idea in the corpus** and the direct ancestor of
  our `fetch/diagnose.ts`.
- `web.py:756-960` — SSRF that validates hostname *and* resolved IPs, blocks `198.18.0.0/15` and metadata,
  re-validates the final URL after redirects, caches only when private networks are disallowed, and
  offers `trusted_proxy_domains` as a narrow escape hatch.
- `server.py:104-129` — `research_brief(query, max_sources=3, max_chars_per_source)`: search, fetch a
  few short excerpts, return one payload. Our `fetch_top` is the same idea folded into `search`.
- `truncation.next_call` — the response includes a ready-to-send continuation call.
- Progress notifications during long calls; `status_summary`/`steps` in every payload; short-query
  retry when a long query returns low-relevance results; source weighting toward official docs.
- `init` writes routing guidance into `~/.claude/CLAUDE.md` and installs a `PreToolUse` hook that denies
  native `WebFetch` for allow-listed third-party models (`hooks/guard.py:14-27`); `doctor` checks config,
  hook executability and backend connectivity.
- The contradiction: a Chrome UA plus `Referer: https://duckduckgo.com/` (`web.py:28-32, 1081-1089`)
  despite the no-bypass policy.

**Insights.**
1. Refusing well is a *feature*. A classified, actionable refusal stops the model from hammering a wall
   and makes the tool's behaviour auditable.
2. Search-and-skim in one call is the highest-leverage context saver; the model's job is judgment, not
   pagination.
3. Ship the model guidance (CLAUDE.md snippet, hook) with the server. Where it should and shouldn't be
   used is part of the product.
4. Policy docs and code must agree. Their UA/referer undermines an otherwise exemplary posture; our
   `POLICY.md` names the code paths so the two can be checked against each other.

**Taken:** diagnosis envelope, SSRF re-validation after redirects, one-call search+skim, "next call"
continuation hint in the footer. **To consider:** progress notifications for batch fetches; a
`doctor` command; a CLAUDE.md snippet for routing.

---

## webfetch (firish, Python) — `webfetch/`

**What it is.** Search + fetch with a semantic cache, multi-engine RRF fusion, and a real evaluation
harness. PyPI `webfetch-llm`, MCP-registry `server.json`, a Claude Code plugin.

**How it works.**
- `webfetch/fetch/html.py:181-231` — an escalation ladder trafilatura → requests-with-browser-headers →
  Playwright, triggered on 403 or when text < 300 chars. `fetch/base.py:11-21` says the Chrome UA exists
  because "a bare Mozilla/5.0 UA ... got us 403'd by fandom/oup/tiktok".
- `fetch/html.py:30-75` — tables via `pandas.read_html` appended as markdown; `<title>`/`og:description`
  prepended because "factoids live there".
- `fetch/pdf.py:126-144` — a **legibility gate** that drops garbled columnar PDF pages before they poison
  the ranker.
- `config.py:74-82`, `tool.py:230-238` — volatility-aware cache TTLs (`realtime | recent | stable`) with a
  `[cache: ...]` provenance line on every result and a `force_fresh` escape hatch.
- `evals/` — three layers: an offline matcher eval (285 paraphrase pairs plus hand-written adversarial
  negatives such as "latest React version" vs "latest Vue version", `build_datasets.py:47-51`; selection
  rule: highest recall with precision ≥ 0.98), a live pipeline eval (recall@chunks, tokens/result,
  latency, failed fetches), and an end-to-end eval of eight arms (their own modes, Anthropic hosted,
  OpenAI hosted, Tavily, Exa, Perplexity) on 50 SimpleQA questions with cost per search.
  `evals/results/README.md` maps every claim in the README to a JSON file and keeps negative results.
- Packaging: `server.json` for the MCP registry with `isSecret` env declarations; `plugin/` contains no
  code, just `.mcp.json` running `uvx --from webfetch-llm@latest` so plugin installs never go stale;
  `tests/test_packaging.py` guards version agreement across four files.
- `docs/ROADMAP.md` — what their users asked for: stale-while-revalidate, freshness → engine time filters,
  domain include/exclude, cache-only "lockdown" mode, SearXNG adapter, structured extraction, shared team cache.

**Insights.**
1. Evaluate or you're guessing. Adversarial cache negatives ("latest React" vs "latest Vue") are exactly
   the failure a semantic cache has, and they tested for it. We have fixture tests for extraction and
   nothing measuring answer quality; this is the best model for a next step.
2. Cache TTL by volatility class, with provenance shown to the model, is the right shape for a
   cross-session cache. Ours is a flat 24 h; the roadmap item is real.
3. Packaging that can't go stale (plugin → `@latest`) is a good trick.
4. Their honest note about the 403s is the whole scraping story in one sentence: an honest UA gets
   blocked by some sites, and every project then chooses whether to lie.

**Taken:** `og:`/title prepend idea (we use `<title>`/og:title), the "lockdown"/allow-list idea
(`FEARCH_ALLOW_DOMAINS`). **To consider:** volatility-aware TTLs, an eval harness, MCP-registry
`server.json`, PDF legibility gate.

---

## webfetch-mcp (manull) — `webfetch-mcp/server.mjs`

**What it is.** One 924-line Node file over a self-hosted SearXNG, Readability + jsdom.

**How it works.**
- `server.mjs:46-97` — an **agent-facing call budget**: 12 calls per 5 min and 8 per 30 s, with a refusal
  text that says why ("prevents overwhelming websites") and how many calls remain.
- `server.mjs:125-137` — a 1-second per-hostname delay.
- `server.mjs:236-306` — passes SearXNG's `engines`, `time_range`, `safesearch`, `site`, `language` through
  to the tool schema.
- `server.mjs:596-604` — refuses binary content with a message telling the model what to do instead.
- The bad half: a six-UA rotation pool, a self-referential fake `Referer` (`:168`), a random 500–1500 ms
  "simulate human browsing" delay (`:517-519`), header randomization "to avoid fingerprinting"
  (`:527-538`), no SSRF guard beyond a protocol check, and `JSDOM(..., { resources: "usable" })`
  (`:629-633`) which makes the server download every page subresource.

**Insights.**
1. A per-session budget whose refusal *teaches* the model is a better throttle than silent sleeping. We
   implemented it (`politeness.ts` `charge()`).
2. Delays "to look human" and delays "to be polite" are the same `sleep` with opposite intent; write down
   which one you mean. Ours is documented as politeness and is per-host, not randomized.
3. Don't let your HTML parser fetch subresources.

**Taken:** the explanatory budget refusal, per-host delay. **Not taken:** UA pool, fake referer, header
randomization.

---

## scrapling-fetch-mcp (cyberchitta, Python) — `scrapling-fetch-mcp/src`

**What it is.** A thin MCP over `scrapling`: `basic` = curl-cffi TLS impersonation, `stealth` = patchright
(CDP-patched Playwright) with browserforge fingerprints, `max-stealth` = plus WebRTC blocking
(`_scrapling.py:10-24`). The README headline is "bypass anti-automation measures".

**How it works (the good parts).**
- `_fetcher.py:63-101` — the best result envelope for pagination: `METADATA: {total_length,
  retrieved_length, is_truncated, percent_retrieved, start_index, match_count}` so the model can compute
  the next call exactly.
- `_fetcher.py:31-58` — `s_fetch_pattern(url, search_pattern, context_chars)`: regex extraction with
  merged overlapping windows and `[Position: start-end]` delimiters, so a follow-up `s_fetch_page` can seek.
- `skills/s-fetch/SKILL.md` — ships a Claude Code skill whose `references/install.md` is loaded only on
  failure, keeping setup text out of context. The same skill also instructs the agent to escalate
  `basic → stealth → max-stealth` unprompted.
- `protego`, a robots parser, is in the dependency tree and never called (`uv.lock:1218`).

**Insights.**
1. Regex-with-positions is a genuinely useful third read mode ("does this page mention X, and where")
   that costs almost no tokens. Worth adding alongside `focus` and `section`.
2. The metadata envelope with `percent_retrieved` is a nicer continuation signal than ours; cheap to add.
3. Auto-escalation in a skill file means the *agent* walks up the evasion ladder without the user
   deciding. Whatever your posture is, put it in code, not in prompt text the model may or may not follow.

**Taken:** nothing yet. **To consider:** `pattern=` read mode; `percent_retrieved` in the footer; the
on-failure-only install reference pattern for a skill.

---

## orz-mcp (sunwu51) — `orz-mcp/stdio/client.mjs`, `streamable-http/`

**What it is.** Two implementations of `web_search` (Brave + DDG HTML scraping, regex-parsed) and
`web_fetch` (Turndown), one for stdio and one hosted on Netlify Functions.

**How it works.**
- `client.mjs:503-596` — declares `outputSchema` for both tools; the only repo here that does.
- `client.mjs:430-457` — regex `<main>/<article>/#content/<body>` extraction then Turndown with
  `codeBlockStyle: "fenced"`.
- `client.mjs:126-153` — four-UA rotation; `--proxy` flag for users behind the GFW.
- `streamable-http/netlify/mcp-server/index.ts:17-45, 295-326` — forges `Referer`, `Origin` and a
  `Cookie: kl=us-en`, and when DDG returns a CAPTCHA it rotates the query through **five anonymous
  third-party DDG proxies** (a Fermyon app, a Cloud Run URL, a Lambda URL, two Workers). The hosted
  `web_fetch` has `cors({ origin: "*" })`, no auth, no SSRF check and no rate limit — a public open proxy.

**Insights.**
1. Silently sending users' queries to five unaccountable third parties is the single worst pattern in the
   corpus, and it is invisible to the user unless they read the source. Disclose every third party in the
   output; we print the provider on every search result.
2. A hosted fetch endpoint needs auth, SSRF checks and limits *before* it exists; the hosted variant here
   would fetch `http://169.254.169.254/` for anyone.
3. `outputSchema` is nice to have; the rest is a cautionary tale.

**Taken:** disclosure-in-output as a principle. **Not taken:** everything else.

---

## duckduckgo-mcp-server (nickclyde, Python, v0.6.1) — `duckduckgo-mcp-server/src`

**What it is.** The most-installed DuckDuckGo MCP server (PyPI `uvx duckduckgo-mcp-server`): two tools,
`search` and `fetch_content`, FastMCP, stdio/SSE/streamable-HTTP transports, Docker, a `CLAUDE.md`,
`SECURITY.md`, unit + e2e tests with a fake-DDG HTML factory. Read 2026-08-29.

**How it works.**
- `server.py:86-90` — POSTs `https://html.duckduckgo.com/html` with a **hard-coded Windows Chrome 139
  User-Agent** (a plain `httpx` client pretending to be Chrome), `kl` region and `kp` SafeSearch form
  fields (`DDG_REGION`, `DDG_SAFE_SEARCH`), 30 requests/minute limiter (`:34-50`).
- `server.py:61-75` — recognises DDG's block: "html.duckduckgo.com now serves an HTTP 202 with an empty
  results page to clients whose TLS fingerprint it doesn't like (issue #46)". Their fix (`:259-330`):
  backend `auto` (the default) retries with **`curl_cffi` Chrome-131 TLS impersonation**; the README
  section is literally titled "Backends (bypassing bot detection)".
- `server.py:349-460` — a proper SSRF guard (resolves DNS, blocks loopback/RFC1918/link-local/metadata,
  re-checked on redirects; `allow_private_urls` opt-out). Better than most of the set.
- `fetch_content` (`:531-580`): GET + BeautifulSoup, drops `script/style/nav/header/footer`, `get_text()`,
  8,000-char truncation, no continuation, no robots.txt, no code-block preservation.
- Ops polish: `--ca-certs` for TLS-intercepting corporate proxies, `--no-ssl-verify` last resort,
  DNS-rebinding allow-lists for the HTTP transports.

**Insights.**
1. **Independent confirmation of our core finding.** The most popular DDG server hits the exact wall we
   measured — DDG's 202 bot-check on plain clients — and its answer was to escalate to TLS impersonation.
   Ours is to open the page DDG's robots.txt permits (`/lite/`) in a real, self-identified browser. Same
   goal, opposite side of the identity line; theirs is the rung-9 fact pattern (`SPECTRUM.md`).
2. Region and SafeSearch (`kl`, `kp`) are cheap, real user value we don't expose. Worth a `region`
   setting and passing `kl`/`kp` on the lite URL.
3. Their `fetch_content` is what "fetch" means to most users: text soup, 8k cap. Our extraction (code
   blocks, tables, sections, cursor, focus) is a genuine differentiator worth stating plainly.
4. The corporate-proxy details (`--ca-certs`) are the kind of thing that decides whether a tool works at
   all behind a TLS-intercepting proxy. Node honours `NODE_EXTRA_CA_CERTS`; we should document that and
   make sure Playwright's Chromium gets the same CA (it doesn't by default).
5. A `CLAUDE.md` + `SECURITY.md` + e2e-over-the-protocol test layout is the expected shape for a
   published MCP server; adopt the same.

**Taken:** (to do) `kl`/`kp` region + SafeSearch; document `NODE_EXTRA_CA_CERTS` and verify the browser
tier behind an intercepting proxy; `SECURITY.md`; protocol-level e2e tests.
**Not taken:** the fake Chrome UA on a plain client, the `curl_cffi` fallback, the 8k text-soup fetch.

---

## Four engine-specific search servers (read 2026-08-29)

Cloned to see how the ecosystem reaches Google and Bing. They split cleanly into "official API, key
required" and "Playwright plus stealth, no key" — nobody sits where we do.

### mcp-google-search (adenot, TS) — `mcp-google-search/src/index.ts`
- Google **Custom Search JSON API** (`googleapis.com/customsearch/v1`, `:99-101`): needs a Cloud project
  with billing, an API key and a `cx` engine ID. Plus a cheerio `read_webpage`.
- **Insight:** this is the only *legitimate* Google route in the set, and Google has closed it to new
  customers with a 2027-01-01 shutdown (`SPECTRUM.md`). Confirms there is no keyed Google option left
  except Gemini grounding.

### bing-search-mcp (leehanchung, Python) — `bing-search-mcp/mcp_server_bing/server.py`
- Official **Bing Web Search API** (`api.bing.microsoft.com`, `Ocp-Apim-Subscription-Key`, `:108-121`),
  honest UA `mcp-bing-search/1.0`, web/news/image tools, rate limiting.
- **Insight:** clean, and dead — Microsoft retired the Bing Search APIs in August 2025. Same lesson
  as above: the official engine APIs are disappearing; agents are being pushed to scrape or to pay
  the LLM vendors for search.

### google-search-mcp (`@mcp-server/google-search-mcp`, TS) — `google-search-mcp/src/search.ts`
- Playwright with `--disable-blink-features=AutomationControlled` (`:192`), a saved **fingerprint**
  file (locale/timezone/UA, `:105-124`) and `storageState` persistence (`:152-159, 279-284`).
- The interesting part: it starts headless, and on a `google.com/sorry` / recaptcha page
  (`:397-413`) **relaunches headed so the person can pass the check**, then saves the state so the next
  run is headless again. Types the query into the search box with random per-key delays (`:541`)
  rather than loading the results URL.
- Extraction: `h3` + first `a` per result container, snippet `.VwiC3b, [data-sncf='1']` (`:572-580`)
  — the pre-2026 markup; will now return `/goto?url=` tokens as URLs.
- **Insights.** (1) Their headless→headed→headless dance is our handoff with the identity lie added:
  the human-in-the-loop idea is independently validated, the stealth flag is what separates the two.
  (2) State persistence *is* what makes Google usable — same finding as ours (the exemption cookie).
  (3) Their state file also stores a fabricated fingerprint; ours stores only what Google set.

### noapi-google-search-mcp (VincentKaufmann, Python) — `noapi-google-search-mcp/src/google_search_mcp/server.py`
- 38 tools, headless Chromium with an injected stealth script (`navigator.webdriver=false`, fake
  plugins, `delete window.__playwright`, `:67-147`), cookie persistence (`~/.google_mcp_cookies.json`,
  `:151-164`), human-like random delays, and — new in v0.3.1 — a **neural-net reCAPTCHA image solver**
  (MobileNetV2 + OpenCV, human-like mouse movement, `:198-446`). README: "honestly we mostly built it
  because we could."
- Extraction (`:540-575`): `div#search div.g` → `a[href^="http"]` + `h3`, with a fallback over all
  `div#search a[href^="http"]` that contain an `h3`. Pre-2026 markup as well.
- **Insight.** This is the far end of the spectrum in one package: stealth patches, fabricated
  identity, and automated CAPTCHA solving (rung 11). Useful as the reference for "what we are not";
  also a reminder that as soon as Google started challenging headless Chromium (their issue #2), every
  scraping project's next step was to solve the challenge by machine. Ours hands it to a person.

**Cross-check on our parser.** Both Playwright repos read `a[href^="http"]` inside `div.g`. Google's
2026 markup no longer puts the destination in the href (`/goto?url=<token>`), so both are broken today
against the page we captured; our JSON-join + `<cite>` fallback is the current working approach.

**Taken:** nothing new in code — the headed-on-challenge pattern and state persistence were already
built; confirmation that region/locale (`hl`, `kl`) is a common user need. **Not taken:** fingerprint
files, stealth scripts, typed-query simulation, CAPTCHA solving, retired/closed official APIs.

---

## Cross-cutting patterns

**What every good server converged on** (and we implement): markdown output; `max_chars` + `start_index`
continuation with an explicit "call again with N" footer; batch URLs with bounded concurrency; a main-content
locator; SSRF blocking; `Accept: text/markdown`.

**What almost nobody did** (and we do): honest identification, robots.txt, per-host politeness, refusing
without escalation, disclosing third parties, licence signals. The gap is cultural, not technical — each of
these is under 100 lines.

**What the field is missing that we should still add** (ranked by value):
1. An evaluation harness with adversarial cases (webfetch).
2. Freshness: `content_age` / `is_stale` from `Last-Modified` and page dates, and volatility-aware cache
   TTLs (Hound, webfetch).
3. A `pattern=` read mode with positions (scrapling) and `percent_retrieved` in the footer.
4. Progress notifications for multi-URL fetches and a `doctor` command (CC-Web).
5. An optional, honest headless mode for JS-only pages — `waitUntil`, resource blocking, timeout salvage,
   *no* stealth (fetcher-mcp's feature list minus its init script).
6. MCP-registry `server.json` and a plugin that pins `@latest` (webfetch).

**On identity, practically.** Nobody in this set — including Anthropic — puts a person's contact in the
UA. The convention is `Product/version (+URL)`, where the URL explains the agent and names the robots.txt
token. That is what we ship by default, with no configuration required.
