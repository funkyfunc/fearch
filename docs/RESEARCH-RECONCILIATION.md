# Reconciling the two research reports with the design

Two reports were produced from `RESEARCH-PROMPT.md` on 2026-08-28: *Keyless AI Web Fetching Research*
(faster agent, newer model — "A") and *Keyless Web Reading Tool Architecture* (deeper reasoning, older
model — "B"). This note records where they agree, where they disagree, what was verified, and what
changed in the code as a result.

## Where both reports agree — and what we did

| Finding | A | B | Action |
|---|---|---|---|
| **No reliable, ToS-compliant, keyless general-web search exists in 2026 without scraping a commercial engine.** Exa's keyless endpoint is the least-bad option; it rate-limits after a burst. | ✔ | ✔ (explicit) | Accepted at the time; superseded the same day by the DuckDuckGo finding below (its ToS has no automation clause and its robots.txt permits `/lite/`). Exa is now the second keyless provider, with cooldown + disclosure; the first-party federation is much broader (below), and `FEARCH_SEARCH_MODE=first-party` removes third-party search entirely. |
| **Federated first-party APIs are the right primitive for developer questions**, not a search engine. | ✔ | ✔ | Added providers: Hacker News (Algolia), arXiv export API, OpenAlex, Semantic Scholar, Marginalia; new `kind` values `papers` and `community`; tool description now steers the model toward a `kind` when the question fits. |
| **DuckDuckGo's terms prohibit automated querying** even though robots.txt allows `/lite/`. | ✔ | ✔ | **Checked the primary source and this is wrong.** DuckDuckGo's Terms of Service (duckduckgo.com/terms, 2026-08-28) contain no clause about automation, bots, scraping or rate limits; both reports cited proxy-vendor blogs and the separate Duck.ai terms. Its robots.txt allows `/lite/` and `/html/`. What DDG does have is a per-IP bot-check (HTTP 202). Resolution: DuckDuckGo lite is now queried through the self-identified browser tier as a keyless general-web provider (after Exa), and the bot-check page is treated as a final "no" with a cooldown. The impersonation-based scraper stays opt-in. |
| **Honest headless browser = ordinary corporate practice; stealth = deception.** Append the product token to the browser UA. | ✔ | ✔ | Kept. Changed the browser to new-headless full Chromium (`channel: "chromium"`) so the UA is the ordinary Chrome UA + our token, not the generic `HeadlessChrome` marker that bot managers treat as "unknown scraper" (A: 75% of headless blocks are header-level; B: explicit recommendation). Disclosure is now by an attributable token rather than a bare marker. |
| **Refusals: one browser attempt after a plain-client 403 is defensible; a CAPTCHA/challenge is final.** | ✔ (calls it a grey area, then endorses it) | ✔ | Already implemented. |
| **Exa (any hosted search) is a privacy/exfiltration concern; disclose, and provide a toggle to disable external search.** | ✔ | ✔ | Provider named on every result; added `FEARCH_SEARCH_MODE=all|first-party|off`. |
| **Stack Exchange content is CC BY-SA — attribute.** | ✔ | ✔ | Stack Overflow fast path now shows author names, per-answer links, and a licence line; search disclosures and page headers carry licence facts for Stack Exchange, Wikipedia, MDN. |
| **crates.io / Wikimedia: identifying UA with a URL is compliant.** | ✔ | ✔ | Already the case. |
| **arXiv: use the export API for discovery, ≤1 request / 3 s.** | ✔ | ✔ | arXiv provider uses the export API; per-host gap of 3 s (also Semantic Scholar 3 s, Marginalia 4 s). |
| **Wayback: user-directed lookups fine at low rate.** | ✔ | ✔ | Already the case (explicit `archive=true`, only for 404/410). |

## Where they disagree — and how it was resolved

**1. robots.txt tokens.** They attack our default from opposite sides. *B*: RFC 9309 says honour only your own token and `*`; adopting other vendors' tokens is non-standard and gives no legal protection. *A*: a site that blocks training crawlers wants to stay out of LLM ecosystems entirely, so we should honour *all* AI tokens. Neither cites an operator statement about user-initiated fetch tokens specifically. Resolution: the default stays "own token + `*` + the user-initiated agent tokens" (the tokens that describe exactly what we are), with `strict` (all AI tokens, A's reading) and `minimal` (RFC-pure, B's reading) as one-line settings. The README now recommends `strict` where a security team wants the most conservative reading. Both critiques are recorded in `POLICY.md`.

**2. Web Bot Auth.** *B* says an open-source local tool can register with Cloudflare's directory and sign requests as an "Intermediary Agent". *A* makes the decisive objection: the private key would have to ship in a public repository, would be extracted by scrapers, and the identity revoked — so a purely local, no-sign-up tool cannot use it without central infrastructure that holds the key. A is right. Web Bot Auth is recorded as a non-goal for this architecture (it would need a hosted signing service, which breaks "run locally, no accounts").

**3. TLS fingerprinting.** *A* says heavily defended sites drop non-browser TLS handshakes before reading the honest UA and suggests browser-like TLS "while retaining the honest UA". We do not do this on the plain client (it is protocol-level impersonation regardless of the UA). The honest way to present a genuine Chrome TLS handshake is the browser tier — which is exactly what the escalation does.

**4. GitHub conditional requests.** *A*: 304s don't count against the limit. *B*: unauthenticated 304s do. GitHub's own docs say conditional requests returning 304 do not count; B's claim is unsourced. We don't poll, so it doesn't matter here.

## New things the reports surfaced that were not in the design

- **Content Signals** (`Content-Signal: search=yes, ai-input=no, ai-train=no`, as an HTTP header or a `robots.txt` line — Cloudflare/contentsignals.org, 2025). `ai-input=no` means "do not feed this content into an AI model", which is precisely what a coding assistant does with a fetched page. Now honoured under the `default` and `strict` robots policies (refusal with `kind: content_signal`), and always surfaced in the header. `minimal` surfaces without refusing.
- **`Link: rel="llms-txt"` / `X-Llms-Txt`** response headers advertising an agent index — now surfaced as a note.
- **Headless browser resource cost** — the browser process now closes after 60 s idle and relaunches lazily.
- **A's "multi-purpose bot trap"** (Cloudflare judges a bot by its strictest category) and the **Sept 2026 default block on Agent/Training traffic for new zones** — no code change, but they reinforce: expect refusals on Cloudflare-fronted consumer sites, and never try to look like something else.

## Tested directly: search engines through an honest headless browser (2026-08-28)

Same-day measurement with the self-identified new-headless Chrome (`navigator.webdriver` untouched):
Google returned an "unusual traffic" block page; Bing returned 200 with ten **decoy** results unrelated
to the query; DuckDuckGo lite returned its 202 bot-check page — from an IP that had answered plain
requests earlier that morning before a day of test traffic. Conclusion: "a headless browser used like a
human" does not get engine results without hiding the automation signals, which is the stealth line this
project does not cross; DuckDuckGo is the only engine where the attempt is even permitted, and its
answer is IP-dependent. Whether a clean IP is served is still to be verified from another network.

**Follow-up measurement, same day — the UA token is the trigger.** Isolating variables against
DuckDuckGo lite: headless + stock Chrome UA → results; headed + UA with our token → bot-check; headless
+ stock UA + identification in `From`/`X-Agent` headers → results; headless + UA with token → bot-check.
Headed vs headless made no difference anywhere (Bing still served decoys, Google still blocked — those
key on `navigator.webdriver`/IP). So both reports' advice to append the product token to the browser UA
is the one thing that reliably gets the honest browser refused. The browser tier now identifies via
`From:` (RFC 9110 §10.1.2) and `X-Agent:` headers by default, keeping Chrome's own UA; the UA-token form
remains available as `FEARCH_BROWSER_IDENTITY=ua`. DuckDuckGo lite answers the default configuration
from this IP, and — being engine results that are robots-permitted, keyless and not logged by DDG — it is
now the first keyless general-web provider, ahead of Exa.

**Using the person's own Chrome instead (considered, rejected).** Driving the user's real, logged-in
browser (via CDP or an extension) would make Google/Bing return results, because the automation signals
they key on would be absent. It was rejected: the tool could no longer identify itself (that is the whole
mechanism — it would be indistinguishable from the person), every query would be attributed to the
person's Google/Microsoft account and could get *that* flagged, an agent driving a logged-in browser is
a security surface a corporate reviewer would refuse on sight, and those engines' robots.txt and terms
forbid automated result-page access however it is done. It is the "authenticated-profile reuse" rung
the user already declined.

**Measured 2026-08-29 — the automation flag.** Launching the installed Chrome headed with Playwright's
`--enable-automation` dropped (`ignoreDefaultArgs`) leaves `navigator.webdriver` **true**: Chromium sets
it whenever it is driven over the DevTools pipe. So there is no innocuous "don't announce" flag; the only
way to make it false is `--disable-blink-features=AutomationControlled`, the stealth switch, which this
project does not offer. Same run: DuckDuckGo lite and Bing returned real results; Google returned its
IP-level "unusual traffic" page with a reCAPTCHA — the case the headed tier's human handoff exists for.
The "use the person's own Chrome" idea from the previous paragraph was then re-examined and adopted in
a different form: not the person's real profile (Chrome refuses automation on it) but their installed
Chrome with a tool-owned profile, visible, with challenges handed to the person — the *user-agent
posture* (`SPECTRUM.md`, "Two axes"). It is a set of dials, off by default.

## What was *not* adopted, and why

- Inverting the search order to "federation first, engines last" for open-ended web queries (B). For prose questions the federation is markedly worse than an engine or Exa, and their failure modes are already handled (cooldown, disclosure, fallback). Users who want zero third-party search have `first-party` mode.
- Requiring users to provide exact URLs instead of searching (A's "honest conclusion"). That is what `FEARCH_SEARCH_MODE=off` does, for those who want it.
- Any form of TLS or behavioural emulation on the plain client.

## Confidence notes

Both reports lean on secondary sources for several claims (IPRoyal/proxy-vendor blogs for DuckDuckGo's ToS; dev.to posts for OpenAlex/Semantic Scholar limits; a `pkg.go.dev` package page for arXiv's rules). The readability percentages in B's first table are unsourced estimates. The one primary academic source (arXiv 2606.14525, *Detecting Bot Detection*) measured datacenter vantage points, not residential ones. Treat the numbers as directional.

## Report C (2026-08-31): "Human-Supervised Fetching vs Crawling" (`docs/research/`)

Commissioned to stress-test the person-present rule before it shipped. Verdict of the report: the
framing is "a highly defensible, emerging standard". Independent verification of its pillars:

- **Verified, primary source.** OpenAI's live crawler docs (developers.openai.com/api/docs/bots,
  fetched 2026-08-31) state of ChatGPT-User, verbatim: *"Because these actions are initiated by a
  user, robots.txt rules may not apply."* This is the strongest citable industry precedent for the
  person-present rule, and RFC 9309 does scope itself to "automatic clients known as crawlers".
  DuckDuckGo's DuckAssistBot (real-time fetch, no training) is a second vendor on the same line.
- **Real, but only as a dispute.** Amazon sued Perplexity over the Comet browser's agentic shopping
  (filed 2025-11-05; Guardian/Verge coverage confirmed via HN). The report's centerpiece — a Ninth
  Circuit ruling of 2026-08-04 ("Amazon.com Services, LLC v. Perplexity AI", agent = "tool, not a
  person", access attributed to the human) — **could not be verified anywhere**: no HN, no news, no
  reachable docket, and the timeline (appellate ruling nine months after filing) is improbable.
  Treat the "ruling" as unconfirmed at best and likely a hallucinated synthesis. **Do not cite it.**
  The argument stands on Van Buren / hiQ / Meta v. Bright Data without it.
- **Directionally consistent, unverified specifics.** Cloudflare's Search/Agent/Training taxonomy and
  its 2026 WAF defaults; the Perplexity stealth-crawling report (2025, real) is characterised fairly.
- The report's four mitigations (human-passed challenges, one query per action, honest identity,
  robots-by-default as an "ethical surplus") are exactly what shipped; no changes were made because
  of the report. Its Web Bot Auth recommendation stays set aside for the key-publishing reason in
  ROADMAP. Its "fetch logged-out" advice (Meta v. Bright Data) protects a *tool operator*; in the
  person-present model the person is the user, and whether their own logged-in profile browses is
  their choice (`FEARCH_INCOGNITO=1` exists for the other preference).
