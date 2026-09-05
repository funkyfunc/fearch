# fearch access policy

This document is for security and legal reviewers. It states exactly how the server behaves on the
network. Every rule below is enforced in code and covered by tests; the code paths are named so the
claims can be audited. See `SPECTRUM.md` for the reasoning and sources. Settings are named here by
their environment-variable spelling (`FEARCH_BROWSER`); every one is also a flag with the same name
(`--browser`), and the flag wins — the table is `FLAGS` in `packages/core/src/config.ts`.

## Identity

- Every request carries `User-Agent: fearch/<version> (+<info-url>)`. The product token is
  fixed (it is what operators match in robots.txt); the URL defaults to the project's *Bot info* page and
  can be pointed at an organisation's own bot page via `FEARCH_UA_INFO_URL`. This is the same
  convention as Googlebot, Bingbot and Claude-User — no personal contact is required or expected;
  `FEARCH_UA_CONTACT` exists for deployments that want to append one.
- The User-Agent cannot be set to a browser string. There is no configuration option to do so.
- No TLS fingerprint impersonation, no header randomization, no fake `Referer`/`Origin`. The plain
  HTTP client holds no cookies. The browser tier's cookies are exactly what a person's browsing
  creates: the headed mode's tool-owned profile keeps what the person did in that window, and the
  extension mode is the person's own Chrome profile (their choice to pair it); reads that carry a
  person's session are labelled in the result header.

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
  There is no setting that turns robots.txt off for the tool's own fetching (one existed until
  2026-09-02 and was removed: its only job had been to make Google eligible without a person present,
  and Google is now an explicit engine choice). Two independent reviews argued for each end of the
  remaining range (see `RESEARCH-RECONCILIATION.md`): that a training-crawler block signals a wish to
  stay out of AI systems entirely, and that RFC 9309 only contemplates a client's own token.
  Organisations that want the most conservative reading should set `FEARCH_ROBOTS_POLICY=strict`.
- **Content Signals** (`Content-Signal: search=yes, ai-input=no, ai-train=no`, as a response header or
  a `robots.txt` line) are honoured under `default` and `strict`: `ai-input=no` means the site does not
  want its pages fed into an AI model, which is exactly what this tool does, so the content is withheld
  and a `content_signal` diagnosis is returned.
- **Person-present rule.** robots.txt governs the tool fetching on its own. Google result
  pages are never opened by default: they are used only when the operator lists them in `--engines`
  *and* a person is on call — a window (or their own Chrome via the extension) can reach them and
  handoff is on. Those pages are then that person's own browsing, automated only in the sense that
  the query is typed and the result read back for them, and every gate a site raises is decided by
  them personally; they are opened without consulting robots.txt, exactly as their own Chrome would.
  Every such query is the person's act: before it reaches Google it is shown to them in their MCP
  client (the query, editable; "Search on Google" with the engine about to run preselected;
  "Incognito", default from `FEARCH_INCOGNITO`, the alternative being their signed-in Chrome or the
  tool-owned profile; "ask me again next time") and runs only on their accept; where the client cannot show a form, the query is filled into the engine's search box and
  the person submits it. `FEARCH_HUMAN_SEARCH=1` shows the form for every query, DuckDuckGo lite
  included. Ordinary page fetches — the tool acting alone — stay under
  the robots policy above in every mode, and where no person can be reached (no display, handoff
  off, explicit headless) the carve-out simply does not apply. Two things must be said plainly about
  this path. First, no disclosure to the engine is possible on it: a declared automated client is
  exactly what these engines refuse, so the page is opened as the person's Chrome and nothing else,
  and the result header says so. Second, the precedent is the agent-in-the-user's-browser category
  — Microsoft's Copilot Cowork ("a hidden Edge tab … uses your existing single sign-on, cookies, and
  sessions", CAPTCHAs handed back to the person), Anthropic's Claude in Chrome ("shares your
  browser's login state … pauses and asks you to handle [a CAPTCHA] manually"), Google's own Gemini in
  Chrome ("automatically uses … Google Search" from the person's Chrome); all verified on the
  vendors' pages 2026-09-02, see `SPECTRUM.md` and `docs/CASES.md`; and *Amazon v. Perplexity*, 9th Cir.
  2026-08-04, No. 26-1444, which held that an agent acting at the user's direction from the user's
  own browser is a tool and the *user* is the one who accesses the site — a CFAA holding that the
  court expressly limited to that architecture and that leaves a site's terms of service intact), not
  the declared-agent category: OpenAI's `ChatGPT-User` and Anthropic's `Claude-User` are *fetch*
  agents that identify themselves, and neither company reads search results by driving a user's
  browser. RFC 9309 scopes itself to "automatic clients known as crawlers". See
  `RESEARCH-RECONCILIATION.md`, Report C.
- If `robots.txt` returns 401/403, the host is treated as disallowed. This is a choice, not the RFC's
  rule: RFC 9309 §2.3.1.3 lets a crawler treat a 4xx as "no robots.txt" and read; §2.3.1.4 mandates
  disallow only for 5xx/network failures, which fearch also honours. A network failure while
  fetching robots.txt is not cached (the next call asks again); an answer from the host is cached for
  an hour. When the page URL was upgraded from `http://` optimistically, the robots.txt probe may fall
  back to plain http exactly as the page fetch may.
- `X-Robots-Tag`, `<meta name="robots">`, `noai`/`noimageai`, RSL and AIPREF headers are recorded and
  shown in the tool output so downstream use can respect them.
- Requests to documented public APIs (`api.github.com`, `raw.githubusercontent.com`, `pypi.org`,
  `registry.npmjs.org`, `api.stackexchange.com`, `crates.io`, MDN's and Wikipedia's search endpoints)
  are made under those services' API terms; robots.txt governs page crawling, not API clients. The
  exact list is `API_ENDPOINTS` in `packages/core/src/fetch/resolver.ts`, and such requests are marked
  `robots: not consulted (documented API, its terms apply)` in the output. The operator's
  `FEARCH_ALLOW_DOMAINS` / `FEARCH_DENY_DOMAINS` lists apply to these hosts like any other.

## The browser tier

- When the plain HTTP client receives an empty client-rendered shell — by shape (an empty mount
  point, a "turn on JavaScript" stub) *or* by result (the extractor finds no readable content, or a
  negotiated markdown/text body is a stub of under 100 characters) — or is refused (403 / WAF /
  challenge page), the page is opened **once** in a real Chromium (Playwright). The browser is read
  until the DOM stops being a shell (bounded), so a client-rendered app is not captured before it
  hydrates. This is the same thing a person does when a page needs a browser, and it is ordinary
  corporate automation (`docs/SPECTRUM.md` rung 7).
- **Five modes** (`FEARCH_BROWSER`: `auto` | `headless` | `headed` | `extension` | `off`). `auto`
  (default): page renders happen in the bundled headless Chromium; when a page comes back as a challenge
  and a display exists, the person is asked and that one page is opened in a visible window (the
  installed Chrome) and handed to them — passed, its clearance persists in the tool-owned profile so the window need not
  reappear; unanswered, no further windows are opened (and no further tabs activated in the person's
  Chrome) for 10 minutes; where no window can be shown,
  the challenge is final. **Engine result pages are never rendered headless**: with the extension
  connected they open in the person's own Chrome; otherwise in a background window of the installed
  Chrome with the tool profile, which comes forward only when a check needs the person (or they must
  press Enter). On macOS, Chrome activates itself on DevTools-protocol traffic (a Chromium bug, worse
  since Chrome 146), so that window comes forward on every engine search; the extension tier, which
  drives nothing over DevTools, is the quiet path there and `doctor` says so. Where no window can be
  shown, no engine is available and `search` says so. The
  person's own Chrome via the paired bridge extension is preferred over all of this whenever it is
  connected. `headless`: never a window, no engine search, no state survives the process
  (Chromium itself is downloaded lazily on first need, never in a postinstall). `headed`: every render
  in the Chrome already installed on the machine (so it receives the machine's enterprise policy —
  URL blocklists, proxy, certificates), visible, with the **tool-owned profile** persisted under the
  cache directory. Chrome refuses automation on a person's real profile; the tool profile starts
  empty and only ever contains what the person did in windows the tool opened. `off`: no browser
  tier at all.
- **Extension mode** (`--browser extension`). Pages are opened in the person's own Chrome by the bundled
  "fearch bridge" extension (`packages/core/extension`, a few hundred lines, readable in full). No
  automation flags, no DevTools/CDP, no injected scripts beyond reading the page: it is the person's
  browser doing what browsers do. The extension knows `open` (a background tab, http(s) only, private
  addresses refused server-side), `read`, `close`, and `activate` (bring a tab forward for the handoff);
  it never clicks, types or submits, and only touches tabs it opened. It talks only to a fearch on the
  same machine: the server binds 127.0.0.1, accepts requests only from the extension's fixed origin,
  and both sides are **paired through a shared secret** written by `fearch extension install`
  (`<cacheDir>/extension-token` and `token.json` in the extension folder). The token never crosses the
  wire — the extension proves it holds it with a SHA-256 over a fresh nonce on every poll, and the
  server must prove it back on every job before the extension executes anything, so a local process
  that binds the port first cannot drive the person's Chrome. Pages open with the person's own profile
  (their logins, their search history) and are labelled as such; `FEARCH_INCOGNITO=1` opens them in an
  incognito window instead. If the extension is not connected, fearch falls back to the headless tier
  and says so in the log (including that the handoff is unavailable until it connects).
- **Human handoff** (on by default whenever a window could reach the person — auto with a display,
  headed, or extension; `FEARCH_HANDOFF=0` opts out). When a page or search engine shows a challenge,
  the person is asked first, through their MCP client: "A bot check appeared on host. Open it for
  you?" The question is the tool's result — an MCP `input_required` round (protocol revision
  2026-07-28; on a 2025-era connection the SDK turns it into an elicitation request) — and the page
  that hit the check waits in the background, suspended, for the answer to come back on the next
  call. On yes the check is surfaced — the auto tier brings that one page forward in a window;
  headed brings the tab to the front; the extension activates the tab in the person's Chrome — and
  the tool waits (default 45 s from the yes, `FEARCH_HANDOFF_TIMEOUT_MS`) for the person to deal with
  it, then continues with what they were shown. On no, that is the answer. If nobody answers, the
  client reports the timed-out prompt (the same timeout bounds each round), the suspended page closes
  a minute later, and the next request asks again — there is no backoff, because the prompt itself
  is the test of presence. A client that cannot show a prompt gets the pre-prompt behaviour (the tab
  or window is surfaced straight away, and an unanswered one earns a 10-minute pause on further
  windows). If the check is still there, the answer is a `captcha_or_challenge` diagnosis marked
  retryable that says where the check is waiting and that the same URL may be called again once the
  person is there — the one retry of a refused URL that is correct. The tool clicks, types and solves
  nothing; it only watches for the page to stop being a challenge. The extension activates the tab
  and asks for attention (dock/taskbar) without taking focus. Without handoff, or where nothing can
  be shown, a challenge is final.
- **Session.** The tool-owned profile (headed/auto) holds only what the person did in windows the
  tool opened — passed checks, above all. It is sent to engine pages (that is where a passed check
  lives) and never to ordinary page reads; there is no setting that forwards it to ordinary pages
  (one existed until 2026-09-02 and was removed). Through the bridge extension, ordinary reads in
  `auto` go to the logged-out headless tier first and reach the person's Chrome only for a check;
  `--incognito` keeps the person's profile out of engine pages too.
- **Identity.** Every request from the Playwright tiers carries `From:` (RFC 9110 §10.1.2 — the
  header defined for a robot to name who controls it; set to the bot-info URL or `FEARCH_UA_CONTACT`)
  and `X-Agent: fearch/<version> (+<info-url>)`. There is no setting that removes them (one existed
  until 2026-09-02 and was removed). The User-Agent is whatever the browser itself reports and is
  never set or edited: `HeadlessChrome/…` from the headless tier, `Chrome/…` from a window. (Until
  2026-09-05 the headless tier rewrote `HeadlessChrome` to `Chrome` so that DuckDuckGo lite would
  answer it; that edit hid an automation signal and was removed — engine pages now always open in a
  real window instead. Appending the product token to the UA was measured, 2026-08-28, to trigger
  bot-checks that key on unusual UA strings, and is not done.) For ordinary page reads, robots.txt is evaluated under our own
  token *before* the browser requests anything, so an operator's stated decision is honoured
  regardless of what their access log shows; engine result pages under the person-present rule are
  the one documented exception (see *Consent signals*).
- **In every mode:** no automation-signal hiding (`navigator.webdriver` is left true — measured
  2026-08-29: Playwright-driven Chrome reports it true regardless of launch flags, and the only way to
  make it false is the stealth flag `--disable-blink-features=AutomationControlled`, which this project
  does not offer), no fingerprint changes, no stealth plugins, no CAPTCHA solving, no credentials held
  by the tool. Downloads and service workers are disabled. In headless mode images, fonts and media are
  not loaded (bandwidth courtesy); headed windows load them because a person is looking. Requests to
  private/internal addresses are blocked at the request gate.
- The browser attempt is subject to the same robots.txt decision, the same per-host queue, and costs two
  units of the session budget in total (the plain attempt paid the first). It is used only on the
  URL the model asked for; it never navigates further.
- If the rendered page is a CAPTCHA, challenge, login form, paywall or still a shell, the refusal is
  **final** and the Diagnosis lists both attempts — the same detector that decides to hand a page to
  the person decides whether what came back is still a check, so an interstitial is never returned
  as content. The one exception is a check handed to the person and not yet passed (above). The
  server never solves challenges.
- `FEARCH_BROWSER=off` disables the tier entirely.

## Refusals are final

- HTTP 401, 402, 403, 407, 451, and any bot-challenge / CAPTCHA / login / paywall page are reported to
  the model as a structured diagnosis (`kind`, `retryable=false`, `attempts`, `nextAction`).
- The only escalation is the single, self-identified browser attempt described above. The server never
  retries a refused request with a different identity, headers, IP, proxy, cookies, or via a third-party
  service.
- HTTP 429 and 503 with a short `Retry-After` (≤ 15 s) are obeyed exactly: the server waits the stated
  time and retries once. A longer or absent `Retry-After` is a final diagnosis that surfaces the stated
  wait — no invented backoff, no repeated retries.

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
- Search queries go to the configured engines only — nowhere else, ever. The engine is named in
  every result header. There are no third-party search services of any kind — keyed or keyless — no
  hidden fallback sources, and no query ever leaves for one; when no engine answers, the search fails
  with the reasons. `FEARCH_SEARCH_MODE=off` disables the search tool entirely. (The fetch tool's
  documented API fast paths — GitHub, PyPI, npm, Stack Overflow, arXiv — are for reading URLs the
  model already has; search queries never reach them.)
- The Playwright tiers (headless, headed) send the browser's own User-Agent, unedited, with
  `From:`/`X-Agent:` naming this tool (see *The browser tier*). The bridge extension does **not**: it is the person's own
  Chrome, sending exactly what their Chrome sends, and every result it produced says `your Chrome`
  (`doctor` reports the same). Cloudflare's
  Web Bot Auth (signed requests) is **not** used: a locally-run open-source tool cannot hold a private
  signing key without publishing it, which would be extracted and revoked.
- **Search engines.** Engine result pages are opened only in a browser a person could see (their own
  Chrome, or a background window of the installed Chrome), never headless; with no display there is no
  engine search. With no person on call for checks, the only engine result pages this server requests
  are DuckDuckGo's `/lite/`, because DuckDuckGo's robots.txt explicitly allows them (verified live
  before every request) and its Terms of Service contain no automated-access clause (checked 2026-08-28).
  Google disallows `/search` for crawlers and is used only when listed in `FEARCH_ENGINES` and
  eligible under the person-present rule (a person on call — any check the engine raises opens in a
  window, or their own Chrome, for them to decide); with `FEARCH_HUMAN_SEARCH=1` each query is shown
  to the person in their MCP client, editable, and runs only when they accept it (or, where nobody
  can be asked that way, the search box is handed over in the browser). Bing was removed 2026-09-02:
  it served decoy results to automated browsers and its home page cannot carry a query without
  submitting it. `doctor` reports exactly which
  engines are in use and why the rest are not. Engine pages are opened in the same browser tier as
  page reads, one query per search call, at least 3 s apart. A bot-check page is that engine's "no"
  to the tool and a question for the person: they are asked whether to open it, and pass it
  themselves or not. With a person on call there is no cooldown — the next search asks again. Only
  where nobody can be asked (headless, no display, `FEARCH_HANDOFF=0`) does the provider sit out for
  5 minutes, and the note says at what time it was refused; nothing is done to avoid the check.
- No telemetry, no version pings, no crash reporting.

## Safety limits

- Private, loopback, link-local, multicast and cloud-metadata targets are refused, in IPv4, IPv6 and
  the IPv4-mapped / IPv4-compatible IPv6 spellings (`[::ffff:127.0.0.1]`, which the URL parser
  canonicalises to `[::ffff:7f00:1]`). DNS is resolved before connecting *and* the address the socket
  actually connects to is checked again at connection time (`guardedLookup` in `fetch/guard.ts`,
  wired into the HTTP client's connector), so a name that rebinds between the two lookups is still
  refused; every redirect hop is re-validated. An explicit
  `https://` URL is never retried over plain http; only a bare host or an `http://` URL that was
  upgraded optimistically may fall back.
- 10 MB response cap, 30 s request timeout, 6 redirect hops, ≤5 URLs per call.
- Domain allow list (`FEARCH_ALLOW_DOMAINS`) and deny list (`FEARCH_DENY_DOMAINS`).
- Every request is written to the audit log (`FEARCH_AUDIT_LOG`, default stderr) as one JSON line:
  time, URL, method, status, bytes, robots decision, provider, cache hit.

## Host memory

When the plain client fails on a host and the browser tier succeeds, the host is remembered for 24 h
and the next read on that host starts with the browser. This changes only *which client goes first*;
identity, robots.txt, politeness and refusal handling are identical.
