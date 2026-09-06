# Roadmap

Priorities after v2.0 (2026-08-28). Sources for each idea are in `LEARNINGS.md`. The posture in
`POLICY.md` is fixed; nothing below adds impersonation, stealth, proxies, CAPTCHA handling, or
retry-after-block.

## Guiding expectation

The target is honest, free web search and page reading for any agent — not just coding agents: a
client that works on the pages people actually read (docs, news, reference, GitHub, Q&A, blogs,
PDFs) and reports clearly when a site chooses not to serve automated readers. It will hit the same walls Claude Code's
WebFetch hits — Cloudflare-challenged consumer sites, paywalls, JS-only apps, most social media — and it
is not a goal to get through them.

## Done since v2.0 (2026-08-28, same day)

- **Google URLs as a person's address bar writes them (2026-09-06).** Only the query, Google's own
  date filter (`tbs=qdr:`), and the tab (`udm=50` for AI Mode, `udm=14` for the plain Web view).
  `num=`, `hl=` and `gl=` are gone: ten results is the default, and the browser's Accept-Language
  and the network already carry the locale — a person's URL never has them, and AI Mode, which is
  `/search` with one parameter, is the most sensitive to any it does not expect. DuckDuckGo lite
  keeps `kl=` and `df=`, which its own settings write into the URL.

- **Incognito is a session, not a query (2026-09-06).** The maintainer passed two bot checks for
  two incognito queries: each opened a fresh context and Google checked it again. Both tiers now
  keep the incognito session — the Playwright context while the browser runs, the extension's
  incognito window minimised with a blank tab for 20 minutes after its last fearch tab — so a
  passed check holds across queries and still nothing reaches disk. Extension 2.3.0 (reload it).

- **Rendering audit as a live check (2026-09-06).** `npm run audit:render` measures, per page,
  the paragraphs, headings, code blocks, data tables and image alt text the markdown keeps against
  the page's main container (links stripped, markup-insensitive, formulas and link rails set
  aside), and prints what was lost. The same measure gates `tests/live/render.test.ts` on eight
  stable pages (paragraphs ≥ 90 %, code 100 %). Fixed from its first run: utility classes read as
  roles, formulas printed twice, image alt text dropped, definition lists flattened. AI Mode reads
  on the same ladder as every engine page — reply and sources, else the page as markdown — and
  `raw=true` returns the rendered page, redacted. A Google page that is still streaming its reply
  is no longer mistaken for a bot check (reCAPTCHA scripts are on every Google page); a real check
  is kept on disk, redacted, like a zero-parse page.

- **Google AI Mode as an engine (2026-09-06).** `--engines google-ai`: the `udm=50` reply is the
  answer, its citations are the results, under the Google result-page posture (approval per query,
  the person's browsing, incognito default). Measured through the bridge: the reply carries no
  disclaimer, so its feedback form is the end marker; citations load seconds after the reply, so
  the render waits up to 25 s for both. An answer without citations is still returned; the chain
  goes on to DuckDuckGo for result links. One question per call, never a follow-up (SPECTRUM,
  "Indexes, not models").

- **The results ladder (2026-09-06).** A results page is read in three rungs, each named in the
  output: the engine's own parser (exact, joined to the page's embedded rows); the page's shape —
  title links, display URLs, snippets — for any engine and any layout, marked approximate; and the
  results column as markdown when nothing reads as a result (Google's plain `udm=14` view is tried
  once first). Lower rungs are never cached and the page is kept, redacted, for the parser fix.
  The search tool also returns the outcome as `structuredContent` (the `--json` shape).

- **Google's generated answer, rebuilt (2026-09-05, same evening).** The review removed the AI
  Overview extraction as fragile; the maintainer wanted it, so it was rebuilt from real pages
  captured through the bridge (`tests/fixtures/google/`). Nothing depends on a class name: the block
  is the smallest element holding both the label people read ("AI Overview", "AI Mode reply", "Web
  Guide") and the disclaimer that ends it, the smallest *finished* one when a streaming placeholder
  sits beside the answer. It is converted with the page converter (headings, lists, tables, code
  survive; the collapsed "Show more" half is kept), the citation cards become the sources, chips and
  chrome lines are dropped, and the query echo is removed by the query itself. The same capture
  showed Google's **Web Guide** layout — AI-written sections, no `<h3>` — which the results parser
  read as "no results" (the maintainer's own incident); results are now headings inside links in
  either layout, joined to the page's embedded rows by URL, and Web Guide's intro is the summary.
  The render waits up to 8 s for a streaming answer on every tier.

- **Third outside review (2026-09-05; report in `review-notes.md`).** Docs made true: POLICY's
  *Session* paragraph now says every Playwright render shares the tool profile (it does, and must,
  for a passed check to hold); the profile file is 0600 and `fearch clear-profile` empties it.
  Never garbage: a yield rule catches script-heavy pages that render to a footer (YouTube), RSS/Atom
  feeds render as one heading per entry, the read-mode outline is computed on the same link-stripped
  text it windows (it listed sections that were on screen), MDX component code and Wikipedia's
  FlaggedRevs box are dropped, a heading that names the query wins `focus`, an llms.txt keeps its
  links. Consent read as specified: robots.txt `Content-Signal` is scoped to the User-agent group
  and path prefix the spec gives it; a robots.txt 401/403 is `robots_unavailable`, not
  `robots_disallowed`. Search: an unanswered or declined Google form no longer stops the search —
  DuckDuckGo still runs and a note says so; `allowed_domains` (≤3) reach the engine as `site:`
  operators; `blocked_domains`, the unimplemented result `date`, and
  three tuning flags (`--max-bytes`, `--excerpt-chars`, `--log-file`) are gone; a zero-parse engine
  page is always kept, redacted, so "no results" can be diagnosed after the fact. Hygiene: `doctor`
  no longer calls httpbin.org; the `/llms.txt` probe runs only for a home page or a thin landing
  page; the live test asserts what the product is; `server.json` drops `headed`; the flag table's
  defaults are checked against the code by a test.

- **MCP SDK v2 and protocol revision 2026-07-28 (2026-09-05).** `@modelcontextprotocol/sdk` 1.x gave
  way to `@modelcontextprotocol/server` 2.0 (`/client` in tests). The revision has no server→client
  request channel, so the two questions to the person — the query form and "open this bot check?" —
  now travel as `input_required` results: the tool returns the prompt with a sealed request state,
  the client's next call carries the answer, and the render that hit the check is suspended in
  between (`PendingChecks`; it closes itself if nobody comes back). On 2025-era connections (Claude Code
  today: it negotiates 2025-11-25 and sends no discover probe) fearch asks through an elicitation
  request itself, on its own clock, so an unanswered prompt keeps fearch's own wording rather than
  the SDK shim's "Request timed out"; on 2026-07-28 the client owns the wait. `fearch`
  serves both eras over stdio through `serveStdio`; a child-process test pins 2026-07-28. Retired
  with it: the in-process "unanswered" outcome (a prompt nobody answers never reaches a tier now).
  A client's `cancel` (the elicitation answer for "dismissed or timed out without a choice") is
  treated as no answer, not a no: the search says so and nothing runs; a bot-check page keeps
  waiting and the next fetch of the same URL asks about that same waiting page. Same day:
  `--browser headed` removed (`auto` already opens the installed Chrome for engine pages and checks,
  and reads other pages headless; a visible tab per page read was the only thing headed added).

- **The person decides (2026-09-04/05, from the second outside review).** Fixes first: an SSRF hole for
  hex-form IPv6-mapped literals, browser escalation on empty extraction, honest handoff messages, flag
  validation, a robots probe that can fall back to http. Then the design: a query form (query, engine,
  profile, ask-again) before any Google query and, with `--human-search`, before every query; a
  prompt before any bot check is surfaced (yes opens it, no is the answer, silence means away and the
  next request asks again); the engine cooldown only where nobody can be asked (5 min). Then engine
  result pages moved out of headless entirely — the person's Chrome, or a background window of the
  installed Chrome — which retired the headless tier's `HeadlessChrome`→`Chrome` UA rewrite; `search`
  is unavailable where no window can be shown and says so. The server now sends MCP `instructions`
  built from the settings, so `docs/AGENT-GUIDANCE.md` reaches every client without pasting.
- **Outside review, batch 1 and 2 (2026-09-01).** An independent fresh-eyes review (dogfood → code →
  docs) found a challenge interstitial returned as content, Twoslash code blocks hollowed out,
  Wikipedia infoboxes leaking HTML, shells missed, a DNS-rebinding gap, an https→http downgrade,
  account-bearing debug dumps, and a 3-minute focus-stealing handoff; all fixed with fixtures.
  Posture: DuckDuckGo is the default engine everywhere; Google/Bing are `--engines` opt-ins;
  `FEARCH_INCOGNITO` applies in `auto`; `FEARCH_HUMAN_SEARCH=1` ("you press search") fills the
  query in and lets the person submit it. The Ninth Circuit's *Amazon v. Perplexity* opinion was
  confirmed real (RESEARCH-RECONCILIATION corrected). Then (same day): `--human-search` became an
  editable-query elicitation through the MCP client (browser handoff as the fallback); ordinary page
  reads in `auto` go headless-first and reach the person's Chrome only for a check; Bing, `--robots
  off`, `--browser-identity` and `--browser-session` removed; every setting is a flag; `docs/CASES.md`
  added. Headed stayed as a pinned mode until 2026-09-05.

- **Published + release pipeline (2026-09-01).** npm package `fearch-mcp` (bare `fearch` blocked as
  too similar to `fetch`; the command, UA token, and repo stay `fearch`); v2.0.1 released by the
  GitHub Actions pipeline — tag push → Linux+macOS suite → tag/version guard → `npm publish
  --provenance` under npm trusted publishing (OIDC, no token). Repo description, 14 topics,
  CI/npm/license badges; README made fully self-contained (no outbound links, user's call).
- **Handoff elicitation + raw DOM + MCPB builder (2026-09-01, Report D items).** A challenge handed
  to the person now also notifies them through their MCP client via form-mode elicitation, aborted
  when the handoff resolves (form, not URL mode — URL elicitation would send the person to a fresh
  copy of the page in the wrong cookie jar; also works around an SDK bug dropping cancellations for
  request id 0). Unanswered escalation windows close themselves instead of orphaning. `mode=raw`
  returns the rendered DOM when the browser was needed, not the empty pre-JS scaffold. `npm run
  mcpb` builds the one-click Claude Desktop bundle. Also: pattern mode greps like grep (gim flags);
  fetching `/robots.txt` itself is exempt from the robots gate; Turnstile interstitials whose text
  hides in the cross-origin iframe are detected; engine robots census (2026-08-31, live): Mojeek,
  Ecosia, Startpage, Marginalia all disallow their results paths — DDG lite remains the web's only
  robots-permitted engine.

- **Locale-aware engines (2026-08-31, from google-search-mcp's honest host-derived locale).** Engine
  URLs, `Accept-Language`, and the browser context now speak the machine's real locale (`FEARCH_LOCALE`
  / `LC_ALL` / `LANG`; `de_DE.UTF-8` → DDG `kl=de-de`, Google `hl=de&gl=de`, Bing `setlang=de&cc=DE`;
  no region → DDG worldwide). No invented persona — the honest locale, with an English fallback in
  Accept-Language. Challenge detection stays locale-safe via structural anchors (Google's `/sorry/`
  URL, DDG's HTTP 202, Cloudflare's `cf_chl_`/turnstile markers); the AI-Overview extractor is
  English-labelled and simply stays quiet elsewhere. Eval set broadened with ten general-persona
  questions (health, travel, cooking, tax, reference); judged-vs-baseline grading remains open (#1).
- **General-use refocus (2026-08-31, user's positioning call: "fearch should be for general use").**
  Search now does exactly one thing: engines, or an honest no. Removed the automatic federation
  fallback (its query classifier guessed "technical vs not" and routed legal questions to MDN —
  silently wrong results are the worst failure mode), then the `kind` routing and all eleven
  first-party search providers with it. Engine failures are now surfaced as notes (a robots timeout
  is named, not buried); `recency` is implemented by the engines themselves (DDG `df=`, Google
  `tbs=qdr:`); `FEARCH_SEARCH_MODE` is `all|off`. The fetch fast paths (GitHub, PyPI, npm,
  StackOverflow, arXiv via their APIs) are untouched — they are about reading pages well.

- **`--browser auto`, the new default (2026-08-31, user's UX direction: "headless when I can, surface
  to me when I can't, graceful when nothing can be shown").** Routine renders headless with the tool
  profile; a challenge opens that one page in a visible window for the person (EscalatingRenderer);
  an unanswered window backs off 10 min; no display → challenges final, as before; the paired
  extension is preferred whenever connected (short opportunistic check, quiet note). Engine
  *eligibility* derives from `canSurface` + handoff; the default engine list is DuckDuckGo alone, and
  Google is a `--engines` choice (changed 2026-09-01). Explicit `headless|headed|extension|off`
  were the pins then (headed removed 2026-09-05).
- **Pre-publication pass (2026-08-31).** Person-present rule: with a visible browser whose challenges
  are handed to the person (headed or extension, handoff now on by default there), engine result pages
  are the person's own browsing and Google joins DuckDuckGo without `--robots off`. Flag surface cut to
  four (`--browser --robots --engines --allow/deny-domains`); everything else is env-only. Exa removed
  entirely (no third-party search services remain). Extension bridge hardened with a pairing token
  (`fearch extension install` writes it; SHA-256 proofs both ways, token never on the wire). Retry-After
  (≤15 s) obeyed once, as POLICY promised. `minimal` robots policy folded away. Playwright postinstall
  replaced by lazy first-use download. Tool descriptions now generated from the effective settings.
- **Simplification (done 2026-08-29).** Removed the five keyed providers (Brave/Mojeek/Tavily/Exa-keyed/Anthropic), the opt-in impersonation scraper and `got-scraping`, `FEARCH_SEARCH_PROVIDER`, `FEARCH_IGNORE_ROBOTS`, and the `ua` browser identity. Exa is now opt-in (`--exa`) so the default never sends a query to a third-party service. Configuration is flags in the MCP config's `args`.
- **Ideas queued:** (1) *instant answers* in `search` — DuckDuckGo's official Instant Answer API (`api.duckduckgo.com/?q=…&format=json`, keyless, documented, attribution required) gives an abstract/definition/answer box the model could get before any page fetch; (2) a *Gemini grounding* adapter (`Grounding with Google Search`, free tier 1,500 RPD on 2.5 models) as the one keyed provider worth having, for people who want Google and are willing to get a key; (3) a *scheduled live check* (GitHub Actions, daily `tests/live`) that opens an issue when an engine's markup or a first-party API drifts, so parsers are fixed before users notice.
- **Extension tier (built 2026-08-29).** `--browser extension` + `fearch extension install|status|path`; bundled MV3 extension with a fixed ID, loopback long-poll bridge (no deps, no tokens — origin-checked), three read-only verbs + activate for handoff, `--incognito`, fallback to headless with a note. Verified in Playwright Chromium: render in ~100 ms, DDG search end to end. Open: Web Store listing (one-click install; needs a review), a `--browser auto` that prefers the extension when connected, measuring Google through the extension from a residential IP.
- **Headed tier / user-agent posture** (2026-08-29): `FEARCH_BROWSER=headed` (installed Chrome, visible, tool-owned persisted profile), `FEARCH_HANDOFF` (challenges handed to the person), `FEARCH_BROWSER_SESSION`, `FEARCH_BROWSER_IDENTITY=none`, `FEARCH_ROBOTS_POLICY=off`, `FEARCH_ENGINES=duckduckgo,bing,google` with robots-gated eligibility. Open: measure Google after a person passes its check once (does the profile cookie hold?), Bing decoy detection, an `engine` hint on the `search` tool, a `clear-profile` CLI command.
- **Browser tier** (was v2.3 #12): real headless Chromium, self-identified, one attempt when the plain client gets a JS shell or is refused; no stealth, no cookies, no CAPTCHA handling. Bundled with the package.
- **Freshness** (#2): `Updated: <date> (<age>, <source>)` header from `article:modified_time`, JSON-LD, `<time>`, `Last-Modified`; "may be stale" after a year.
- **`pattern=` read mode** (#3) with `[Position: a-b]` markers.
- **Footer** (#4): percent read and "N of M sections shown".
- **CLI twin + `doctor`** (#5): `fearch fetch|search|doctor`.
- GitHub `tree/` listings and `releases` via the API (the HTML pages are robots-disallowed).
- Layout-table unwrapping (Hacker News and forum threads convert to text; discussions are kept as content).
- **API tightening:** `fetch` is now `mode` + `query` + `cursor` (9 params, was 11); cursors are scoped to their view; one-line header.
- **Per-host "needs browser" memory** (24 h) so known JS-only/refusing hosts skip the doomed plain attempt.
- **Eval harness** (`npm run eval`, `evals/questions.json`, incl. adversarial cases) and `evals/results/latest.json`.
- `docs/AGENT-GUIDANCE.md`, `server.json` (MCP registry), scrape provider folded into the single package.
- Robots policy presets (`default | strict | minimal`), robots re-checked on cross-host redirects.

## v2.1 — trust the output

| # | Item | Why | Done when |
|---|---|---|---|
| 1 | **Grow the eval set — general personas, judged** | 22 dev questions is a smoke test, and now mis-aimed: fearch is for general agent use. webfetch (reference repo) judged itself against a hosted baseline on SimpleQA-style general questions — the only rigorous eval in the corpus. | ~50+ questions across personas (news, health, travel, reference, dev); judged against a baseline, not substring-graded; a scheduled CI run; regressions block releases. |
| 6 | **Progress notifications when the browser engages** | Batch and excerpt progress ship; the browser render itself (3–15 s) is still silent — and the escalation window doubly so. | Progress event before/after each browser render and when a challenge window opens. |
| 15 | **Chrome Web Store listing for the bridge extension — via native messaging** | "Load unpacked" is a dev-only ritual; and Report D found the store path has an architectural precondition: loopback HTTP polling + `<all_urls>` likely fails CWS review, while Chrome **native messaging** is the documented, sanctioned channel for extension↔local-app links. Bonus: stdin/stdout to a Chrome-launched host retires the loopback port (and with it, most of what the pairing token defends against) for the store build. | Store listing published; the store build talks native messaging (extension ↔ Chrome-spawned host ↔ fearch); the unpacked dev build keeps the loopback bridge; `fearch extension install` prefers the store. |
| 16 | **MCPB distribution** | `npm run mcpb` builds the bundle (done, 2026-09-01); it isn't yet built in CI or attached to releases, and it should eventually register the native-messaging host manifest for the store extension. | The `.mcpb` built by the release workflow and attached to each GitHub release; a download link in the README. |
| 18 | **MCP registry submission** | `server.json` is ready and points at the published `fearch-mcp`; the registry (registry.modelcontextprotocol.io) is the discovery hub every client reads. | fearch listed in the official MCP registry; the listing tracks releases. |

## v2.2 — fit into the harness

| # | Item | Why | Done when |
|---|---|---|---|
| 7 | **Volatility-aware cache TTLs** | Flat 24 h is wrong for both news and API docs. webfetch classifies `realtime / recent / stable`. | TTL chosen from host class + freshness signals; `[cache: hit, 3h old]` provenance shown; `fresh=true` escape hatch on `fetch`. |
| 8 | **MCP registry + plugin packaging** | webfetch's `server.json` + a code-free plugin pinned to `@latest` never goes stale. | `server.json` published; `npx -y fearch-mcp` works from a clean machine (the bare `npx fearch` cannot: the npm name is `fearch-mcp`); a Claude Code plugin dir; a packaging test guards version agreement. |
| 9 | **Routing guidance shipped with the server** | CC-Web writes a CLAUDE.md snippet and a hook so the model knows when to use it. | A `docs/AGENT-GUIDANCE.md` snippet users paste into their harness's system prompt; optional skill file. |
| 11 | **Team/shared mode** | Corporate users share an egress; a shared cache halves traffic. | Streamable-HTTP transport behind auth; cache in a shared sqlite/redis; audit log to a file per user. |

## v2.3 — binaries and browser ergonomics

| # | Item | Why | Done when |
|---|---|---|---|
| 12 | **Browser-tier ergonomics** | The tier exists; it can get smarter without getting sneakier. | `wait_for` selector hint from the model; per-host memory of "needs browser" so the plain attempt is skipped next time (still honest, saves a round trip); screenshot-to-disk for pages whose content is visual. |
| 13 | **Binary handling** | Claude Code persists PDFs to disk; MCP resources (mcp-fetch) let clients open them. | Large PDFs/binaries saved under the cache dir and exposed as MCP resources with `listChanged`. |

## Considered and set aside

- **Official keyed search-API fallbacks (Brave/Mojeek APIs) when DOM parsing breaks** (Report D's
  hedge against SERP hostility). Declined: keys and third-party query logging are exactly what was
  removed on 2026-08-31; the honest hedge is what already ships — graceful, reasoned failure, and a
  human who can browse anything. Revisit only if the engines-or-honest-no posture stops serving users.
- **Cloudflare Web Bot Auth / BotBase registration.** Would let Cloudflare-fronted sites recognise the tool cryptographically, but a locally-run open-source tool cannot hold the private signing key without publishing it. Only viable with a hosted signing service, which breaks "run locally, no accounts." Revisit if the standard adds per-installation keys or delegated identities.

## Non-goals (permanent)

- Browser UA strings, TLS/JA3 impersonation, header randomization, fake `Referer`/`Origin`.
- Any retry after 401/402/403/CAPTCHA with a different identity, IP, or third party.
- Opening engine result pages with no person present and no explicit robots-off choice.
- Telemetry, version pings, silent third-party egress.

## Measures of success

- `npm test` fixture suite stays at 100% code-block retention — fences *and* their contents (a hollow
  fence counts as lost; see the Twoslash test); eval harness recall doesn't regress.
- Live suite: honest UA visible; robots-disallowed URL never requested; blocked page → exactly one request.
- Median `fetch` under 2 s for docs pages; `search` under 3 s keyless.
