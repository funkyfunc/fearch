# Roadmap

Priorities after v2.0 (2026-08-28). Sources for each idea are in `LEARNINGS.md`. The posture in
`POLICY.md` is fixed; nothing below adds impersonation, stealth, proxies, CAPTCHA handling, or
retry-after-block.

## Guiding expectation

The target is "Claude Code's WebFetch for harnesses that don't have one, free": an honest client that
works on the sites developers actually read (docs, GitHub, registries, Q&A, blogs, PDFs) and reports
clearly when a site chooses not to serve automated readers. It will hit the same walls Claude Code's
WebFetch hits — Cloudflare-challenged consumer sites, paywalls, JS-only apps, most social media — and it
is not a goal to get through them.

## Done since v2.0 (2026-08-28, same day)

- **Simplification (done 2026-08-29).** Removed the five keyed providers (Brave/Mojeek/Tavily/Exa-keyed/Anthropic), the opt-in impersonation scraper and `got-scraping`, `FEARCH_SEARCH_PROVIDER`, `FEARCH_IGNORE_ROBOTS`, and the `ua` browser identity. Exa is now opt-in (`--exa`) so the default never sends a query to a third-party service. Configuration is flags in the MCP config's `args`.
- **Ideas queued:** (1) *instant answers* in `search` — DuckDuckGo's official Instant Answer API (`api.duckduckgo.com/?q=…&format=json`, keyless, documented, attribution required) gives an abstract/definition/answer box the model could get before any page fetch; (2) a *Gemini grounding* adapter (`Grounding with Google Search`, free tier 1,500 RPD on 2.5 models) as the one keyed provider worth having, for people who want Google and are willing to get a key; (3) a *scheduled live check* (GitHub Actions, daily `tests/live`) that opens an issue when an engine's markup or a first-party API drifts, so parsers are fixed before users notice.
- **Extension tier (idea, 2026-08-29).** A small companion Chrome extension the server talks to over a local WebSocket (the pattern Playwright MCP's bridge and Claude in Chrome use). It would drive the person's *real* profile: real Google/Bing results (no automation signals exist — it is the person's browser), the person's own logins, no separate profile to manage. Costs: an extension to install (blocked by policy in many workplaces, so it cannot be the corporate answer — the headed tier stays for that), a second codebase to ship and keep in sync with the server, and a larger security surface (an agent with tabs in a logged-in browser must be read-only and injection-hardened). Do after the headed tier has been used for a while and only if Google-through-handoff proves too clunky.
- **Headed tier / user-agent posture** (2026-08-29): `FEARCH_BROWSER=headed` (installed Chrome, visible, tool-owned persisted profile), `FEARCH_HANDOFF` (challenges handed to the person), `FEARCH_BROWSER_SESSION`, `FEARCH_BROWSER_IDENTITY=none`, `FEARCH_ROBOTS_POLICY=off`, `FEARCH_ENGINES=duckduckgo,bing,google` with robots-gated eligibility. Open: measure Google after a person passes its check once (does the profile cookie hold?), Bing decoy detection, an `engine` hint on the `search` tool, a `clear-profile` CLI command.
- **Browser tier** (was v2.3 #12): real headless Chromium, self-identified, one attempt when the plain client gets a JS shell or is refused; no stealth, no cookies, no CAPTCHA handling. Bundled with the package.
- **Freshness** (#2): `Updated: <date> (<age>, <source>)` header from `article:modified_time`, JSON-LD, `<time>`, `Last-Modified`; "may be stale" after a year.
- **`pattern=` read mode** (#3) with `[Position: a-b]` markers.
- **Footer** (#4): percent read and "N of M sections shown".
- **CLI twin + `doctor`** (#5): `fearch fetch|search|doctor`.
- GitHub `tree/` listings and `releases` via the API (the HTML pages are robots-disallowed).
- Layout-table unwrapping (Hacker News and forum threads convert to text; discussions are kept as content).
- **API tightening:** `fetch` is now `mode` + `query` + `cursor` (9 params, was 11); cursors are scoped to their view; one-line header.
- Search results carry a **date** when the provider knows one.
- **Per-host "needs browser" memory** (24 h) so known JS-only/refusing hosts skip the doomed plain attempt.
- **Eval harness** (`npm run eval`, `evals/questions.json`, incl. adversarial cases) and `evals/results/latest.json`.
- `docs/AGENT-GUIDANCE.md`, `server.json` (MCP registry), scrape provider folded into the single package.
- Robots policy presets (`default | strict | minimal`), robots re-checked on cross-host redirects.

## v2.1 — trust the output

| # | Item | Why | Done when |
|---|---|---|---|
| 1 | **Grow the eval set** | 22 questions is a smoke test, not a benchmark. | ~50+ questions across ecosystems; a graded run in CI on a schedule; regressions block releases. |
| 6 | **Progress notifications when the browser engages** | Batch and excerpt progress ship; the browser render itself (3–15 s) is still silent. | Progress event before/after each browser render. |

## v2.2 — fit into the harness

| # | Item | Why | Done when |
|---|---|---|---|
| 7 | **Volatility-aware cache TTLs** | Flat 24 h is wrong for both news and API docs. webfetch classifies `realtime / recent / stable`. | TTL chosen from host class + freshness signals; `[cache: hit, 3h old]` provenance shown; `fresh=true` escape hatch on `fetch`. |
| 8 | **MCP registry + plugin packaging** | webfetch's `server.json` + a code-free plugin pinned to `@latest` never goes stale. | `server.json` published; `npx fearch` works from a clean machine; a Claude Code plugin dir; a packaging test guards version agreement. |
| 9 | **Routing guidance shipped with the server** | CC-Web writes a CLAUDE.md snippet and a hook so the model knows when to use it. | A `docs/AGENT-GUIDANCE.md` snippet users paste into their harness's system prompt; optional skill file. |
| 10 | **More first-party federation** | Keyless official APIs are the respectful growth path. | docs.rs, Go pkg index, RubyGems, Hacker News (Algolia API), ReadTheDocs search; `kind` list grows accordingly. |
| 11 | **Team/shared mode** | Corporate users share an egress; a shared cache halves traffic. | Streamable-HTTP transport behind auth; cache in a shared sqlite/redis; audit log to a file per user. |

## v2.3 — binaries and browser ergonomics

| # | Item | Why | Done when |
|---|---|---|---|
| 12 | **Browser-tier ergonomics** | The tier exists; it can get smarter without getting sneakier. | `wait_for` selector hint from the model; per-host memory of "needs browser" so the plain attempt is skipped next time (still honest, saves a round trip); screenshot-to-disk for pages whose content is visual. |
| 13 | **Binary handling** | Claude Code persists PDFs to disk; MCP resources (mcp-fetch) let clients open them. | Large PDFs/binaries saved under the cache dir and exposed as MCP resources with `listChanged`. |

## Considered and set aside

- **Cloudflare Web Bot Auth / BotBase registration.** Would let Cloudflare-fronted sites recognise the tool cryptographically, but a locally-run open-source tool cannot hold the private signing key without publishing it. Only viable with a hosted signing service, which breaks "run locally, no accounts." Revisit if the standard adds per-installation keys or delegated identities.

## Non-goals (permanent)

- Browser UA strings, TLS/JA3 impersonation, header randomization, fake `Referer`/`Origin`, cookies.
- Any retry after 401/402/403/429/CAPTCHA with a different identity, IP, or third party.
- Scraping search-engine result pages in `packages/core` (the opt-in package stays quarantined).
- Telemetry, version pings, silent third-party egress.

## Measures of success

- `npm test` fixture suite stays at 100% code-block retention; eval harness recall doesn't regress.
- Live suite: honest UA visible; robots-disallowed URL never requested; blocked page → exactly one request.
- Median `fetch` under 2 s for docs pages; `search` under 3 s keyless.
