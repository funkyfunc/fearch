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

**Correction, 2026-09-05.** "Keeping Chrome's own UA" above was not what shipped: Playwright's
new-headless Chromium (channel `chromium`, 1.62) still reports `HeadlessChrome/<v>`, and the tier
rewrote that to `Chrome/<v>` — the "headless + stock Chrome UA → results" row was measured with the
edited string. Re-measured 2026-09-03 against DuckDuckGo lite: unedited `HeadlessChrome` UA → 202
bot-check; edited → results; edited + token → 202; the plain `fearch/` client → 202. The edit hid an
automation signal, contrary to POLICY, and was removed: engine result pages now open in a real
window (the person's Chrome, or a background window of the installed Chrome), never headless, and
where no window can be shown there is no engine search.

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
- **Real — corrected 2026-09-01.** An earlier version of this note said the Ninth Circuit ruling
  "could not be verified anywhere" and was "likely a hallucinated synthesis". That was wrong. The
  opinion exists: *Amazon.com Services, LLC v. Perplexity AI, Inc.*, No. 26-1444 (9th Cir. Aug. 4,
  2026), Judge M. Smith, published at
  cdn.ca9.uscourts.gov/datastore/opinions/2026/08/04/26-1444.pdf (fetched through fearch; Reuters
  and Ropes & Gray coverage the same week). Procedural history: complaint filed November 2025;
  the district court granted Amazon a preliminary injunction in March 2026 (calling it a close
  call); the Ninth Circuit stayed and then vacated it. What it holds: the CFAA reaches "whoever …
  intentionally accesses"; the Assistant, "however advanced", is a tool, not a person; because
  Perplexity's servers never communicated with Amazon's and the requests came from the *user's*
  browser, the user — not Perplexity — accessed Amazon's computers, so Amazon was unlikely to show
  "access" by Perplexity at all. Extending the CFAA there would be "a novel interpretation far
  afield" of an anti-hacking statute and could expose users themselves to criminal liability. What
  it does **not** hold: the court says "we do not establish a new legal regime governing agentic AI",
  ties the result to this architecture (local browser, no vendor server in the request path), and
  notes in a footnote that terms-of-service enforcement is untouched — the CFAA is simply not the
  vehicle. Two details matter for fearch: (1) the architecture the court relied on is exactly the
  extension tier's — the person's own browser, a local tool, no fearch server anywhere; (2) "at the
  core of the dispute was Perplexity's decision not to use a 'user-agent string'" that would have let
  Amazon block the agent, and the parties dispute whether Perplexity altered its UA to evade a block
  once identified. The identification question was not decided; it is precisely the one this
  project answers by choice (self-identified everywhere it can be; the person's explicit choice where
  it cannot). Cite it for what it is: a CFAA "access" holding, not a licence.
- **Directionally consistent, unverified specifics.** Cloudflare's Search/Agent/Training taxonomy and
  its 2026 WAF defaults; the Perplexity stealth-crawling report (2025, real) is characterised fairly.
- The report's four mitigations (human-passed challenges, one query per action, honest identity,
  robots-by-default as an "ethical surplus") are exactly what shipped; no changes were made because
  of the report. Its Web Bot Auth recommendation stays set aside for the key-publishing reason in
  ROADMAP. Its "fetch logged-out" advice (Meta v. Bright Data) protects a *tool operator*; in the
  person-present model the person is the user, and whether their own logged-in profile browses is
  their choice (`FEARCH_INCOGNITO=1` exists for the other preference).

## Report D (2026-09-01): "Fearch external-dependency outlook 2026" (`~/.config/google-deep-research/reports/fearch-mcp-server-viability-analysis-20260831-224722.md`)

Commissioned after the general-use refocus to test the external bets: engine access durability,
Chrome Web Store feasibility for the bridge, MCP distribution channels, elicitation, and the bear
case on SERP reading. 54 sources. Verification outcomes:

- **Verified against primary sources.** MCP elicitation **URL mode** exists in the 2026-07-28 spec
  (fetched directly: two modes, `elicitation.url` client capability, `InputRequiredResult`) — the
  protocol-native handoff notification; roadmapped (#17). Chrome **native messaging** as the
  sanctioned extension↔local-app channel is longstanding Chrome documentation; the claim that
  loopback polling + `<all_urls>` invites CWS rejection is consistent with the published review
  policies (roadmap #15 amended). **MCPB/.mcpb** (ex-DXT) one-click bundles are real (roadmap #16).
- **Superseded by our own measurements.** The report returned "data unavailable" for every engine's
  own robots.txt (it honoured the fail-fast clause; its crawler evidently cannot read robots.txt
  files). Our live census (2026-08-31, via fearch): Mojeek `Disallow: /search`, Ecosia
  `Disallow: /search` + `Crawl-delay: 10`, Startpage `Disallow: /do/`, Marginalia
  `Disallow: /search` — all for `User-agent: *`. DuckDuckGo lite remains the only robots-permitted
  engine, confirming the design assumption and the person-present rule's necessity for diversity.
- **Directionally credible, community-sourced.** DDG /html endpoint hardened behind bot checks
  (~Feb 2026) and `vqd` pagination tokens — matches our live observations (we use /lite, one query
  per call, no pagination, so neither bites). Cloudflare crawl-to-refer collapse (~0.2%) framing is
  consistent with Cloudflare's published data.
- **Unverified colour.** The CWS "Purple Potassium" codename and the named example extensions
  (Halo, Locke, AkuBrowser) were not independently confirmed; nothing rests on them.
- **Declined.** Keyed official search-API fallbacks (Brave/Mojeek) as a DOM-breakage hedge —
  contradicts the no-third-party, keyless doctrine; recorded under "Considered and set aside".

## Report E (2026-09-02): "Search Automation Tool Legal Exposure" (`docs/research/`)

Commissioned to map the case law on user-directed browser automation and scraping (US/EU/UK) after
the Ninth Circuit's *Amazon v. Perplexity* opinion turned out to be real. The brief asked for five
specific case histories with primary-source citations. The report instead wrote a general
exposure memo, mostly from secondary sources (law-firm alerts, SEO and proxy-vendor blogs, a Scribd
copy of a contract, Wikipedia). It is useful for its framework and unreliable in its specifics.
Verification outcomes (each checked with fearch against the primary source on 2026-09-02):

- **Right, and useful.** The two-layer picture — the person's exposure is contractual and
  administrative (account suspension, CAPTCHAs, rate limits), the author's exposure turns on
  circumvention and inducement, not on what users do — matches the primary sources. *Meta v.
  Bright Data* (N.D. Cal. 2024-01-23, Chen, J.): platform terms bind account holders using their
  accounts; scraping public pages **logged off** is not a breach of those terms. *X Corp. v. Bright
  Data* (N.D. Cal. 2024-05-09, Alsup, J.): state-law contract/tort claims over public data
  preempted by the Copyright Act. *Berman v. Freedom Financial* (9th Cir. 2022): browsewrap needs
  conspicuous notice. *DPP v. Lennon* (implied consent for ordinary requests), CMA s.3A with the
  CPS dual-use guidance, *Sony* / *Grokster* on tool distribution, *Innoweb* and *CV-Online* on
  database rights — all correctly characterised as far as checked.
- **Stale or wrong.** (1) "Google's search-specific policies prohibit automated queries of any
  sort without express permission" — that wording is from the 2002 terms the report itself cites
  in its archive link; the live terms (policies.google.com/terms, fetched today) contain only the
  robots.txt clause and the "services that encourage others" clause already recorded above.
  (2) "Microsoft Services Agreement prohibits bots, spiders, or meta-search tools" — a stale copy;
  the live agreement says "don't circumvent any restrictions on access … (e.g. impermissible
  scraping)" and separately bars scraping *of its AI services*. (3) "DuckDuckGo's terms restrict
  automated use" — false, for the third time in this corpus, from the same proxy-vendor sources;
  duckduckgo.com/terms has no such clause. (4) *Freeman v. DirecTV* (9th Cir. 2006) is a Wiretap
  Act / Stored Communications Act case, not a CFAA one; the "no civil aiding-and-abetting under the
  CFAA" point may be right but that is not its authority. (5) "Search engine operators do not
  pursue individual consumers in court" — unsourced; plausible, treat as an observation.
- **Ignored.** The brief's five sub-questions: no *Amazon v. Perplexity* at all, no mention that
  hiQ ultimately lost on contract (Nov 2022 summary judgment for LinkedIn; $500,000 consent
  judgment Dec 2022 — verified today), no *Ryanair v. Booking*, no *Kneschke v. LAION*, no *Getty
  v. Stability*, and no status for *Google v. SerpApi* (verified today: the DMCA §1201 claims were
  dismissed 2026-07-20 by Chief Judge Gonzalez Rogers, with leave to amend; the case continues on
  other claims).
- **What it changes for fearch — one thing.** The logged-in/logged-out line runs through *Meta v.
  Bright Data*, *Berman*, and the hiQ contract loss consistently: terms bind an account holder
  using the account; a logged-off visitor faces only browsewrap, which rarely binds; and there is
  no account to suspend. That makes `--incognito` for engine pages a *legal* lever, not only a
  privacy one, and is the strongest argument for making it the default whenever Google or Bing is
  enabled. It does not change the no-circumvention line (the *SerpApi* complaint's SearchGuard
  allegations are exactly what fearch does not do), and it does not soften "providing services
  that encourage others to violate these terms": that clause is the author-side exposure, and
  "you press search" (`--human-search`) is the design answer to it.

## Report F (2026-09-02): "AI Agent Browser Behavior Policies" (`docs/research/`)

Commissioned to settle the norm question from the vendors' own pages: when Google, Anthropic, OpenAI,
Perplexity and Microsoft drive a person's browser, what do they say about search engines,
robots.txt, bot checks and identifying the agent to sites? Sourced overwhelmingly from vendor
documentation this time (45 cited); the report wanders into sandboxing and prompt-injection material
that was not asked for and skips the receiving side (Cloudflare's agent categories, AIPREF) almost
entirely. Verification, each quote read on the vendor page with fearch on 2026-09-02:

- **Microsoft Copilot Cowork, local browser** (learn.microsoft.com, updated 2026-08-28), verbatim:
  "Cowork shows its work in a hidden Edge tab so you can stay in the conversation while it acts on
  your behalf." "Because the tab runs in your own copy of Edge, it uses your existing single sign-on,
  cookies, and sessions. The agent has exactly the same access to sites that you have when you
  browse by hand — no more and no less." Hands the tab back for "a CAPTCHA or human-verification
  prompt", "credentials, such as a password, or a multifactor authentication code". InPrivate
  windows are not supported. No agent identification to sites is described. **This is fearch's
  extension tier, from Microsoft: a hidden tab in the person's own browser, their sessions, the
  check handed to the human.**
- **Anthropic, Claude in Chrome via Claude Code** (code.claude.com/docs/en/chrome), verbatim:
  "Claude opens new tabs for browser tasks and shares your browser's login state, so it can access
  any site you're already signed into. Browser actions run in a visible Chrome window in real time.
  When Claude encounters a login page or CAPTCHA, it pauses and asks you to handle it manually."
  No agent identification to sites is described; the example task is literally "click on the search
  box, type 'hooks', and tell me what results appear".
- **Google, Gemini in Chrome** (Chrome Enterprise release notes), verbatim: "Gemini in Chrome also
  serves as a productivity agent. Gemini in Chrome automatically uses public information from these
  Google services: Google Search, Google Maps, YouTube." Chrome 144–150: "auto browse" and "Gemini
  Spark can use Chrome auto browse to complete tasks that need web actuation." Google's own agent,
  in the person's Chrome, uses Google Search on their behalf; no agent marker to sites is described.
- **Perplexity** (docs.perplexity.ai/docs/resources/perplexity-crawlers), verbatim: `Perplexity-User`
  "supports user actions within Perplexity … Since a user requested the fetch, this fetcher
  generally ignores robots.txt rules." Self-identifying UA and published IP ranges — a *fetcher*
  from Perplexity's servers, the declared-agent category, not a browser agent.
- **OpenAI cloud browser** (help.openai.com article 11845367): the report says every request carries
  RFC 9421 HTTP Message Signatures with `Signature-Agent: "https://chatgpt.com"` and a Cloudflare
  bot ID. Verified verbatim on the page (`Signature`, `Signature-Input`, `Signature-Agent:
  "https://chatgpt.com"`, keys at chatgpt.com/.well-known/http-message-signatures-directory,
  Cloudflare detection ID 129220581, Akamai "ChatGPT Agent", Vercel `chatgpt-operator`). It is the
  *cloud* architecture — OpenAI's servers make the requests — so identification is possible there
  in a way it is not for a local browser.
- **Not answered.** Cloudflare's agent category and whether an individual's browser agent can get a
  signed identity; the IETF AIPREF drafts. Still open; check by hand.

**What it settles.** The three vendors whose agents run in the person's own browser — Microsoft,
Anthropic, Google — all do what fearch's extension tier does: the person's sessions, no
identification to the site, the check handed to the human, and (Google, Anthropic by example) Google
Search used from that browser. The two that identify themselves (OpenAI's cloud browser, Perplexity's
fetcher) can because their servers make the requests. Nobody solves CAPTCHAs. So the norm for a
local browser agent, from the vendors' own documentation, is: inherit the person's browser identity,
never solve a check, hand it to the human. fearch is inside that norm on every point, and stricter
on two — its own plain-HTTP fetches are self-identified and robots-governed, and Google is opt-in.

