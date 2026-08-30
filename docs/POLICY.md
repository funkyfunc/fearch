# fearch access policy

This document is for security and legal reviewers. It states exactly how the server behaves on the
network. Every rule below is enforced in code and covered by tests; the code paths are named so the
claims can be audited. See `SPECTRUM.md` for the reasoning and sources.

## Identity

- Every request carries `User-Agent: fearch/<version> (+<info-url>)`. The product token is
  fixed (it is what operators match in robots.txt); the URL defaults to the project's *Bot info* page and
  can be pointed at an organisation's own bot page via `FEARCH_UA_INFO_URL`. This is the same
  convention as Googlebot, Bingbot and Claude-User — no personal contact is required or expected;
  `FEARCH_UA_CONTACT` exists for deployments that want to append one.
- The User-Agent cannot be set to a browser string. There is no configuration option to do so.
- No TLS fingerprint impersonation, no header randomization, no fake `Referer`/`Origin`, no cookies.

## Consent signals

- `/robots.txt` is fetched (RFC 9309) and cached per host for one hour before any page on that host
  is requested, and again for the new host before any cross-host redirect is followed. `Crawl-delay`
  is honoured.
- Which user-agent groups apply is `FEARCH_ROBOTS_POLICY`:
  - `default` — `*`, our own token, and the **user-initiated agent** tokens `Claude-User` and
    `ChatGPT-User`. Those tokens describe exactly what this server is ("a person asked an assistant to
    open this page"), so a site that blocks them has answered our question. **Training-crawler**
    opt-outs (`GPTBot`, `ClaudeBot`, `CCBot`, `Google-Extended`, …) are *not* applied: this server does
    not train on or store content beyond a short cache, and Google documents `Google-Extended` as a
    training-only control that does not affect reading or search. Treating "don't use me as a dataset"
    as "don't read me" would misstate the site's choice.
  - `strict` — additionally honour the training-crawler opt-outs (the most conservative reading).
  - `minimal` — only `*` and our own token (the literal RFC 9309 reading).
  - `off` — robots.txt is not consulted. This is the *user-agent* posture: RFC 9309 addresses
    "automatic clients" (crawlers), and a person's browser does not read it; a tool driving that browser
    on the person's behalf at human pace takes the same position (as OpenAI's `ChatGPT-User` and all
    computer-use products do). Pace limits, final refusals and the SSRF guard are unchanged. The choice
    is stamped on every result header and logged at startup.
  Two independent reviews argued for each end of this range (see `RESEARCH-RECONCILIATION.md`):
  that a training-crawler block signals a wish to stay out of AI systems entirely, and that RFC 9309
  only contemplates a client's own token. Organisations that want the most conservative reading should
  set `FEARCH_ROBOTS_POLICY=strict`.
- **Content Signals** (`Content-Signal: search=yes, ai-input=no, ai-train=no`, as a response header or
  a `robots.txt` line) are honoured under `default` and `strict`: `ai-input=no` means the site does not
  want its pages fed into an AI model, which is exactly what this tool does, so the content is withheld
  and a `content_signal` diagnosis is returned. Under `minimal` the signal is surfaced but not enforced.
- If `robots.txt` returns 401/403 or cannot be parsed, the host is treated as disallowed (fail closed).
- `X-Robots-Tag`, `<meta name="robots">`, `noai`/`noimageai`, RSL and AIPREF headers are recorded and
  shown in the tool output so downstream use can respect them.
- Requests to documented public APIs (`api.github.com`, `raw.githubusercontent.com`, `pypi.org`,
  `registry.npmjs.org`, `api.stackexchange.com`, `crates.io`, MDN's and Wikipedia's search endpoints)
  are made under those services' API terms; robots.txt governs page crawling, not API clients. The
  exact list is `API_ENDPOINTS` in `packages/core/src/fetch/resolver.ts`, and such requests are marked
  `Robots: api terms` in the output.

## The browser tier

- When the plain HTTP client receives an empty client-rendered shell, or is refused (403 / WAF /
  challenge page), the page is opened **once** in a real Chromium (Playwright). This is the same thing
  a person does when a page needs a browser, and it is ordinary corporate automation
  (`docs/SPECTRUM.md` rung 7).
- **Two modes** (`FEARCH_BROWSER`). `headless` (default): the bundled Chromium, no window, no state
  survives the process. `headed`: the Chrome already installed on the machine (so it receives the
  machine's enterprise policy — URL blocklists, proxy, certificates — and nothing is downloaded), in a
  visible window, with a **tool-owned profile** persisted under the cache directory. Chrome refuses
  automation on a person's real profile; this profile starts empty and only ever contains what the
  person did in that window.
- **Extension mode** (`--browser extension`). Pages are opened in the person's own Chrome by the bundled
  "fearch bridge" extension (`packages/core/extension`, ~150 lines, readable in full). No automation
  flags, no DevTools/CDP, no injected scripts beyond reading the page: it is the person's browser doing
  what browsers do. The extension knows `open` (a background tab, http(s) only, private addresses
  refused server-side), `read`, `close`, and `activate` (bring a tab forward for the handoff); it never
  clicks, types or submits, and only touches tabs it opened. It talks only to a fearch on the same
  machine: the server binds 127.0.0.1 and accepts requests only from the extension's fixed origin, which
  is what stops web pages from driving it. Pages open with the person's own profile (their logins,
  their search history); `--incognito` opens them in an incognito window instead. If the extension is
  not connected, fearch falls back to the headless tier and says so in the log.
- **Human handoff** (`FEARCH_HANDOFF=1`, headed only; on by default in extension mode). When a page or search engine shows a
  challenge, the tab is brought to the front and the tool waits (default 180 s) for the person to deal
  with it, then continues with what they were shown. The tool clicks, types and solves nothing; it only
  watches for the page to stop being a challenge. Without handoff, a challenge is final.
- **Session** (`FEARCH_BROWSER_SESSION`, headed only, default off). Cookies the person created in the
  tool profile are sent to engine pages always (a passed check lives there) and to ordinary pages only
  when on; such reads are labelled `your session` in the result header and in the audit log.
- **Identity** (`FEARCH_BROWSER_IDENTITY`). `header` (default): every request carries `From:`
  (RFC 9110 §10.1.2 — the header defined for a robot to name who controls it; set to the bot-info URL
  or `FEARCH_UA_CONTACT`) and `X-Agent: fearch/<version> (+<info-url>)`. The User-Agent is
  Chrome's ordinary one, because it is Chrome (appending the product token to it was measured,
  2026-08-28, to trigger bot-checks that key on unusual UA strings, and was dropped). `none`: plain
  Chrome with no identifying headers (user-agent posture). Under any
  policy other than `off`, robots.txt is evaluated under our own token *before* the browser requests
  anything, so an operator's stated decision is honoured regardless of what their access log shows.
- **In every mode:** no automation-signal hiding (`navigator.webdriver` is left true — measured
  2026-08-29: Playwright-driven Chrome reports it true regardless of launch flags, and the only way to
  make it false is the stealth flag `--disable-blink-features=AutomationControlled`, which this project
  does not offer), no fingerprint changes, no stealth plugins, no CAPTCHA solving, no credentials held
  by the tool. Downloads and service workers are disabled. In headless mode images, fonts and media are
  not loaded (bandwidth courtesy); headed windows load them because a person is looking. Requests to
  private/internal addresses are blocked at the request gate.
- The browser attempt is subject to the same robots.txt decision, the same per-host queue, and costs two
  units of the session budget. It is used only on the URL the model asked for; it never navigates
  further.
- If the rendered page is a CAPTCHA, challenge, login form, paywall or still a shell, the refusal is
  **final** and the Diagnosis lists both attempts. The server never solves challenges.
- `FEARCH_BROWSER=off` disables the tier entirely.

## Refusals are final

- HTTP 401, 402, 403, 407, 451, and any bot-challenge / CAPTCHA / login / paywall page are reported to
  the model as a structured diagnosis (`kind`, `retryable=false`, `attempts`, `recommended_next_action`).
- The only escalation is the single, self-identified browser attempt described above. The server never
  retries a refused request with a different identity, headers, IP, proxy, cookies, or via a third-party
  service.
- HTTP 429 and 503 with `Retry-After` are obeyed exactly; without it, exponential backoff, at most
  two retries, then a final diagnosis.

## Politeness

- One concurrent connection per host; at least one second between requests to the same host
  (or `Crawl-delay` if larger).
- Conditional requests (`If-None-Match` / `If-Modified-Since`) are sent when a cached copy exists.
- A per-session budget (default 60 page fetches / 10 minutes) refuses further fetches with an
  explanatory message rather than hammering. Calls to search-provider APIs are not charged against it
  (they are bounded by the per-host gap and the providers' own quotas); a provider that rate-limits us
  is put on a 10-minute cooldown and said so in the results.

## Where traffic goes

- Page fetches go directly from this machine to the target host (through `HTTPS_PROXY` if the
  environment sets one). No reader proxies, no archive fallbacks unless the model explicitly asks for
  `archive: true` on a page the target reported gone (404/410).
- Search queries go to the configured search provider only. With no configuration they go to
  DuckDuckGo lite via the self-identified browser (below; DuckDuckGo states it does not log searches),
  then to the first-party APIs. Exa's publicly offered keyless MCP endpoint (`https://mcp.exa.ai/mcp`,
  which logs queries on Exa's side) is used only with `--exa`. The provider is named in every result
  header. There are no keyed third-party providers. Keyless first-party APIs (GitHub, Stack Exchange, npm, crates.io, MDN, Wikipedia,
  Hacker News, arXiv, OpenAlex, Semantic Scholar, Marginalia) are used for `kind`-scoped searches and as
  the fallback. `FEARCH_SEARCH_MODE=first-party` disables every third-party search service so a query
  only ever reaches the site it concerns; `off` disables the search tool entirely.
- The browser identifies itself as ordinary Chrome with `From:`/`X-Agent:` naming this tool (new-headless
  Chromium; see *The browser tier*). Cloudflare's
  Web Bot Auth (signed requests) is **not** used: a locally-run open-source tool cannot hold a private
  signing key without publishing it, which would be extracted and revoked.
- **Search engines.** Under any robots policy but `off`, the only engine result pages this server
  requests are DuckDuckGo's `/lite/` (and `/html/`), because DuckDuckGo's robots.txt explicitly allows
  them and its Terms of Service contain no automated-access clause (checked 2026-08-28). Google and Bing
  disallow `/search` for all agents and become eligible only when the operator lists them in
  `FEARCH_ENGINES` **and** sets `FEARCH_ROBOTS_POLICY=off` — a deliberate two-dial choice that
  `doctor` reports. Engine pages are opened in the same browser tier as page reads, one query per
  search call, at least 3 s apart. A bot-check page is that engine's "no": the provider stops and cools
  down for 10 minutes, or — headed with handoff — shows it to the person; nothing is done to avoid it.
- No telemetry, no version pings, no crash reporting.

## Safety limits

- Private, loopback, link-local, multicast, cloud-metadata and DNS-rebinding hosts are refused, with
  DNS resolved before connecting and every redirect hop re-validated.
- 10 MB response cap, 30 s request timeout, 6 redirect hops, ≤5 URLs per call.
- Domain allow list (`FEARCH_ALLOW_DOMAINS`) and deny list (`FEARCH_DENY_DOMAINS`).
- Every request is written to the audit log (`FEARCH_AUDIT_LOG`, default stderr) as one JSON line:
  time, URL, method, status, bytes, robots decision, provider, cache hit.

## Host memory

When the plain client fails on a host and the browser tier succeeds, the host is remembered for 24 h
and the next read on that host starts with the browser. This changes only *which client goes first*;
identity, robots.txt, politeness and refusal handling are identical.
