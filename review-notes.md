# fearch — fresh-eyes review, 2026-09-05

Read-only review by a fresh agent (Claude, 2026-09-05). Nothing in the repo was touched except
writing this file. Everything below is the deliverable.

Method, in the order asked: dogfood (about 45 tool calls across search, every fetch mode,
multi-URL, PDF, robots-refused, JS-heavy, feeds, CLI `search/fetch/doctor`), then the whole of
`packages/core/src` (8.4k lines) and the tests, then a blindspot pass, then scope, and only then
`docs/`. Four suspected bugs were reproduced with a throwaway script against the source before
being listed. Deep research was not used: nothing open was left that a fetch could not settle,
and the one genuinely open question (why your incognito Google search came back "no results")
needs the page dump the server chose not to keep, not research.

---

## Status after the fix-up (same day)

Everything below was written before any change. The maintainer then asked for the findings to be
acted on; what changed, all under `npm test`/lint/typecheck green (183 tests):

- **Finding 1** — POLICY's _Session_ and _Identity_ paragraphs and a README bullet now say what the
  code does; `browser-state.json` is written 0600; `fearch clear-profile` added. The code was kept:
  the shared profile is what makes a passed check hold.
- **Finding 2** — an unanswered or declined Google form no longer stops the search: engines that need
  no approval run and a note says why Google did not (`registry.ts`, `mcp-server.ts`).
  `allowed_domains` (up to three) go to the engine as `site:` operators; `blocked_domains` and the
  never-set result `date` are gone; a zero-parse engine page is always kept, redacted (last two), and
  "no results" is only claimed when the page carries no result headings.
- **Finding 3** — yield rule in `detectShell` (YouTube now goes to the browser instead of returning a
  footer); RSS/Atom are a `feed` kind rendered one heading per entry.
- **Finding 4** — `read.ts` sections the link-stripped body it windows; verified on the Wikipedia page.
- **Finding 5** — robots.txt `Content-Signal` is scoped to the User-agent group and path prefix.
- **Finding 6** — the AI Overview extraction was removed (Remove list 1).
- **Finding 7** — live test rewritten, `server.json` fixed, `fetchDescription` reads the settings,
  ROADMAP's date claim struck; a test now checks every flag default against the code.
- **Finding 8** — a heading that names the query wins `focus`; llms.txt keeps its links; MDX module
  code, Wikipedia's FlaggedRevs box and stripped-image blank lines are gone; `Universal "*" match`.
- **Finding 9** — `/llms.txt` is probed only for a home page or a thin landing page; `doctor` contacts
  the bot-info host instead of httpbin.org; a robots.txt 401/403 is `robots_unavailable`.
- **Finding 10** — one `askPerson` helper replaces the three copied ask blocks; `MAX_ROUNDS`; the
  log level is validated; `--max-bytes`, `--excerpt-chars`, `--log-file` and the dead search helpers
  are gone.
- **Finding 6, revisited the same evening.** The maintainer wanted the generated answer back. It
  was rebuilt from pages captured through the bridge (`packages/core/src/search/overview.ts`,
  fixtures under `tests/fixtures/google/`): anchored on the label and the disclaimer rather than
  class names, converted to markdown with the page converter, sources from the citation cards, the
  query echo stripped by the query itself, a settle wait for streaming. The capture also showed
  Google's Web Guide layout (no `<h3>`), which explains the "no results" incident; the results
  parser now reads headings inside links in either layout and joins snippets by URL.
- **Not done, deliberately:** moving `docs/research` and `LEARNINGS.md` (repo layout is the
  maintainer's call); removing the "you press Enter" browser path (the CLI still needs it); the
  handoff state machine shared by `browser.ts` and `extension.ts` (a larger refactor than a review
  fix-up should carry); dropping third-party cookies from the saved profile.

---

## Verdict

**As an agent, would I choose fearch over the alternatives today?** For `fetch`: yes, and I
would reach for it before the reference MCP fetch server or Claude Code's WebFetch on any docs,
reference, GitHub, PyPI, Stack Overflow or PDF URL. The extraction keeps code and tables, the
focus/section/pattern modes and scoped cursors are the best long-page ergonomics I have used in
an MCP tool, and a refusal comes back as something I can act on. For `search`: not as my only
search. DuckDuckGo lite alone gives weak results (the README's own example query returned
Japanese and Portuguese Python docs), Google costs a human prompt per query and an unanswered
prompt runs nothing, and domain filters that are enforced after the fact often leave zero
results. Search is the weaker half of the product by a wide margin.

**Would I recommend a non-technical friend install it?** No, not yet. The install is Node plus a
lazy 100 MB Chromium plus, for the good path, loading an unpacked Chrome extension in Developer
mode. The failure vocabulary ("nobody answered within 45 s", "the page waits in the background
for ten minutes", "handoff") assumes the reader knows what the tool is doing. And two ordinary
requests a friend would make, "what's on this YouTube page" and "read this RSS feed", come back
as silent garbage with no diagnosis (finding 3). The MCPB bundle and a Web Store extension are
the right roadmap items; until they ship, this is a tool for people who read READMEs.

What is genuinely good and should not be lost in the list below: the SSRF guard (mapped-v6,
hex, metadata, rebinding all verified live), the honest UA (doctor proved it end to end), the
Diagnosis design, the fast paths, PDF paging, cursor scoping, the extension pairing protocol,
the stdout-purity test, and a test suite that mostly exercises real flows rather than mocks of
mocks. The code reads as one voice. It is not slop.

---

## Top 10 findings, ranked

### 1. The cookie jar contradicts POLICY: ordinary headless reads run in the persisted tool profile

POLICY.md:159-164 says the tool profile "is sent to engine pages ... and never to ordinary page
reads; there is no setting that forwards it to ordinary pages", and POLICY.md:18-21 and the
README "Session" bullet say the same. The code does the opposite. `app.ts:125-130` builds the
routine renderer with `browser: "auto"`, `browser.ts:267-269` makes `profileAllowed` true for
auto, and `browser.ts:875` renders every ordinary page with `session: true` ("Always with the
tool profile"). `saveProfile()` (`browser.ts:405`) then persists whatever those sites set.

Evidence on this machine: `~/.cache/fearch/browser-state.json` holds 29 cookies for
`.g2.com`, `.glassdoor.com`, `.bundlephobia.com`, `.caniuse.com`, `.contentsignals.org`,
`.doubleclick.net`, `.youtube.com`, `.google.com` and others. Only two of those hosts ever saw a
handed-off window. The file is mode `0644` while `extension-token` beside it is `0600`.

Why it matters: the whole pitch is "every claim is enforced in code and covered by tests"
(README, POLICY.md:3-4). This one is false, and it is the claim a security reviewer reads first.
The design tension is real: remembering a passed check for `glassdoor.com` requires the profile
on the next glassdoor read. So the fix is mostly in the document, plus hygiene.

Recommendation: rewrite the Session paragraph to say what is true ("all browser renders share
one tool-owned profile that holds only what the tool's own windows and headless renders
accumulated: passed checks and ordinary site cookies, including trackers"); write
`browser-state.json` with mode 0600 (`chmodSync` after `storageState`); add `fearch
clear-profile` (already on the roadmap); and consider dropping third-party cookies from the
saved state (`state.cookies.filter(c => sameSite(c.domain, visitedHost))`).

### 2. Search is the weak half, and four small things make it weaker than it needs to be

- **Unanswered or declined Google approval runs nothing**, even when DuckDuckGo (no approval
  needed) is also listed. `mcp-server.ts:363-368` returns "Nothing ran"; `registry.ts:290`
  `if (!chosen) break;` stops the chain on a declined form. Yet a declined _bot-check_ prompt does
  fall through to the next engine (server.test.ts:651-656). The two prompts disagree.
- **`allowed_domains` is a post-filter** (`provider.ts:197-210`); only `site` reaches the engine
  (`engines.ts:400`). Three allowed domains over 20 DDG results gave "no results matched the
  domain filters" in dogfood, followed by boilerplate about "any cooldown named above" when none
  was.
- **"Results carry a date when the engine shows one"** (`mcp-server.ts:46`, AGENT-GUIDANCE.md:41,
  ROADMAP.md:119 lists it as done). No engine ever sets `SearchResult.date` (`provider.ts:22`;
  grep `date` in `engines.ts` finds nothing). `isoDate` and `recencyToDays` in `provider.ts` are
  dead.
- **Your incognito Google "no results" is undiagnosable by design.** `engines.ts:494` trusts the
  `noResults` regex the moment zero results parse; the page is dumped only at `--log-level debug`
  (`engines.ts:513-514`). After a passed bot check, a consent or interstitial page that happens
  to contain "did not match" reads as an honest empty answer.

Recommendation (answers your mid-turn question directly): yes, fall through, but never silently.
Treat an unanswered or declined query form as "not on this engine", continue to engines that need
no approval, and put one line in the result: `Note: google: approval unanswered at 20:41 UTC;
ran on DuckDuckGo instead`. With `--human-search` every engine needs approval, so there "nothing
ran" stays correct. Send `allowed_domains` as `site:a OR site:b` when there are three or fewer.
Delete the date claim or implement it for Google (it does show dates in snippets). And on zero
parsed results, always write the redacted page (you already redact) to `<cache>/debug`, keeping
the last two; the cost is nothing and it is the only way the next report like yours gets solved.

Proposed diff for the noResults guard:

```ts
// engines.ts:492-499
if (!parsed.length) {
  const dump = this.dumpUnparsed(rendered.html); // always, redacted, keep last 2
  const empty = this.spec.noResults.test(rendered.html) && !/<h3/.test(rendered.html);
  throw new SearchError(
    empty
      ? `${this.name}: no results for this query${dump ? ` (page saved to ${dump})` : ""}`
      : `${this.name}: no results parsed (markup may have changed${dump ? `; page saved to ${dump}` : ""})`,
  );
}
```

### 3. Silent garbage on pages that are not shell-shaped: YouTube, RSS/Atom

- `https://www.youtube.com/watch?v=...` returned 154 chars of footer ("AboutPressCopyright...")
  as `direct (html/body)`, no diagnosis, no browser attempt. Reproduced: 1,285,360 bytes of HTML,
  `detectShell` false, 753 chars of markdown. `extract.ts:181-182` returns early when visible text
  is under 200 chars unless a known mount point is empty, so the script-share rule at
  `extract.ts:183` never runs; YouTube uses `<ytd-app>`, not `#app`.
- `https://hnrss.org/frontpage` (RSS) came back as CDATA soup with "# Comments: 10" promoted to
  headings, because `transport.ts:119-120` treats any unknown textual body as HTML.

A refusal would have been fine. Garbage presented as content is the one failure the mission says
it will not commit ("nothing is ever silently substituted").

Recommendation: add a yield rule and a feed path.

```ts
// extract.ts detectShell, replace lines 181-184
if (text.length < 50) return scripts > 0;
if (scripts > 0 && emptyMount && text.length < 200) return true;
// A page that is mostly script and yields almost no text is a shell whatever its mount is called.
if (scripts > 0 && text.length < SHELL_MAX_TEXT && scriptBytes / html.length > SHELL_SCRIPT_SHARE) return true;
// Yield: a megabyte of markup that reads as a footer is not the page.
if (scripts > 0 && html.length > 200_000 && text.length < 1_000) return true;
return false;
```

For feeds: in `classify`, `application/rss+xml`, `application/atom+xml`, `text/xml`,
`application/xml`, or a body starting with `<rss`/`<feed` → kind `feed`; render as
`- **title** — link · date` plus the description. Forty lines, and it is what a general-purpose
reader is expected to do.

### 4. The "Sections not shown" outline is wrong in read mode (offset drift)

`read.ts:58` splits sections on `doc.markdown`; `read.ts:75-76` windows the _link-stripped_
`body` from `applyLinkMode`. Every stripped `](url)` shifts later offsets. Reproduced: a section
at offset 140 in the source sits at 45 in the body. On the Wikipedia robots.txt page the outline
listed "Security", "Alternatives" and "Examples" as not shown while all three were on screen;
same on the HTTP status codes page.

Recommendation: split after link stripping.

```ts
// read.ts:58 and :75
const { body, footer } = applyLinkMode(doc.markdown, o.includeLinks);
const sections = splitSections(body);
...
const window = applyBudget(o.mode === "read" ? body : joinSections(selected), offset, o.maxChars);
```

(With `include_links=true` the reference numbers stay stable because they are assigned in
document order before sectioning.)

### 5. Content-Signal is applied site-wide; the spec scopes it by group and path

`robots.ts:46-54` matches any `Content-Signal:` line anywhere in the file. The spec at
contentsignals.org (fetched) shows it inside `User-Agent` groups and with path prefixes
(`Content-Signal: /blog/ ai-train=no, search=yes, ai-input=no`). Reproduced: a file that says
`ai-input=no` only under `User-Agent: googlebot` makes fearch refuse the whole site; a
`/blog/`-scoped line refuses `/about` too. That is not honouring a signal; it is inventing one.

Recommendation: evaluate the line only from groups that apply to fearch's tokens (`*`, `fearch`,
the two user-initiated tokens) and only when the optional path prefix matches the URL. Since
`robots-parser` does not expose groups, a 25-line group walker (split on blank lines, collect
`User-Agent` names, keep `Content-Signal` lines) is enough. Keep the response-header path as is.

### 6. Google AI Overview extraction leaks the query and is the most fragile code in the tree

`engines.ts:276` strips `AI Mode reply for [^A-Z]*` and stops at the first capital letter. My
query `vitest "vi.useFakeTimers" setInterval not advancing` produced an "overview" that began
`FakeTimers" setInterval not advancing When setInterval...`. Reproduced in isolation. The rest
of the function is anchored on a container id and a text marker that the comment itself calls
"volatile and A/B-tested".

Recommendation: remove the feature (see Remove list). If kept, strip the exact query string
instead of a character class: `.replace(new RegExp("^\\s*AI (Overview|Mode reply for " +
escapeRe(query) + ")\\s*"), "")`, which needs the query passed into `overview()`.

### 7. Documentation and tests have drifted from the code in ways that will bite on the next run

- `tests/live/live.test.ts:81-96` asserts "via github" and "the Exa hosted endpoint and the
  federation", both removed 2026-08-31. `live-drift.yml` has never run (GitHub reports zero
  runs); its first Monday run will be red for a reason nobody will recognise.
- `server.json:22` still lists `headed` as a browser mode (removed 2026-09-05).
- `fetchDescription(_s)` (`mcp-server.ts:51`) ignores settings, so with `--no-handoff` or
  headless it still promises "you are asked whether to open it".
- README: "Every rule below is enforced in code and covered by tests" (see finding 1).
- `evals/results/latest.json` is from v2.0.0 and names eleven providers that no longer exist.

Recommendation: fix the live test to what the product is (DDG via a window, or an honest no;
GitHub via `fetch`), regenerate `server.json` from `FLAGS` in the build, make `fetchDescription`
read `personPresent(s)`, and delete the stale eval result.

### 8. Extraction polish: focus ranking, llms.txt substitution, MDX, headings

- `fetch --mode focus --query cancel` on the asyncio page (the README's own example) returned
  "Task object", not "Task cancellation". `sections.ts:246` triples the title in the corpus, but a
  long section that says "cancel" eleven times still outscores a short one titled with the word.
  Add a flat boost when every query token appears in the title (`boost *= 1.5`).
- `https://vitest.dev/` was silently replaced by `/llms.txt` (`pipeline.ts:340-353`) and then
  rendered with links stripped (`render.ts:46`), so the agent got a list of page titles with no
  URLs. An llms.txt is a link index; render it with links, or do not substitute it.
- `mintlify.com/docs` leaked a multi-line `export const HeroCard = ...` JSX block;
  `extract.ts:76` only drops single-line JSX tags.
- `cleanTitle` (`sections.ts:26`) strips literal asterisks, so the heading `Universal "*" match`
  becomes `Universal "" match` in every outline.
- Wikipedia pages open with `**Checked**` / "Page version status" (the pending-changes box is not
  in `REMOVE_SELECTORS`, `extract.ts:52-61`).
- Zillow and PyPI output carry runs of blank lines from list items with stripped images; a
  second `\n{3,}` collapse after link stripping would fix it.

### 9. What a website operator sees in their logs that the docs do not mention

- Every fetch of a root or one-level page probes `/llms.txt` (`pipeline.ts:340-344`), charged to
  the budget, cached one hour in memory only. Operators will see a `fearch/3.0.0` 404 on
  `/llms.txt` for every shallow page read. Probe only at depth 0, or only when extraction is thin.
- `fearch doctor` sends a request to `httpbin.org` (`doctor.ts:33`), a third party, on every run.
  "No telemetry" is true; "no third-party egress" is not, on this path. Use the bot-info page or a
  `--no-network` doctor.
- A robots.txt 403 (Udemy) is reported as `kind: robots_disallowed` ("the operator said no").
  The message text is honest, the kind is not: it was a WAF answering a UA, not an operator
  decision. Add `robots_unavailable` so agents and people stop reading it as consent withheld.

### 10. Code craft: a handful of real smells in an otherwise clean tree

- `mcp-server.ts:488-516` and `:619-636` are the same eight-round legacy-or-input_required loop
  written twice; `browser.ts:693-763` and `extension.ts:569-645` are the same handoff state
  machine written twice. One `askRound()` helper and one `runHandoff(activate, poll)` would
  remove about 150 lines.
- `mcp-server.ts:278` `queryFormSchema(ask, { incognito: false } as Settings)` is a cast to get
  at `names`/`other`; split the schema builder from the name list.
- `config.ts:255` admits FLAGS defaults duplicate the code's defaults as strings; `--max-bytes
"10485760"` is the kind of thing that drifts. Derive the help default from `settingsFromEnv({})`.
- `config.ts:208` accepts any `FEARCH_LOG_LEVEL` from the environment unvalidated;
  `config.ts:120-123` makes `0` impossible for every int flag (`--budget 0` silently becomes 60).
- Dead: `isoDate`, `recencyToDays`, `SearchProvider.posture` (`provider.ts`), the
  `robots: "skipped"` audit value, `PendingChecks.size` outside tests.
- History narrated in code and docs ("removed 2026-09-02", "one existed until ...") belongs in
  git, not in POLICY.md:37-39,161-162,167-168 or `config.ts:509-512`.
- `${8}` in a template literal (`mcp-server.ts:515,636`); `charge(url, units)` with a loop for a
  count that is always 1 (`pipeline.ts:205-212`).
- `transport.ts:112` classifies any `text/plain` starting with `# ` as markdown, so DDG's
  `robots.txt` was titled by its first comment line.

---

## Blindspot pass

**Security reviewer, first thing they notice:** the cookie file (finding 1) and that the bridge
extension has `<all_urls>` + `scripting` and executes whatever a paired server sends. The pairing
design is sound (token never on the wire, proofs both ways, fixed extension ID, origin check);
what is missing is the sentence "a process that can read `~/.cache/fearch/extension-token` can
open any URL in your Chrome" and a 0600 on the cookie jar. Second thing: the pattern-mode regex
runs in `vm.runInNewContext` with a timeout, good; the `focus`/`section` queries are fine; the
`archive` path fetches `archive.org` without the SSRF pre-check on the snapshot URL being
obviously re-validated (it goes through `transport.get`, which does re-validate hops, so this is
fine, but the code should say so).

**Website operator reading logs:** finding 9. Also: the headless Chromium sends
`HeadlessChrome/...` plus `From:`/`X-Agent:`; the extension tier sends nothing. That is
documented, but the bot-info page should show an example of both so an operator can match them.

**Non-technical user:** the verdict above. Add: `fearch search` with no display prints a
paragraph about "engine result pages open only in a browser a person could see"; they will not
know what that means. And the query form defaults "Incognito" to off even for Google, though
RESEARCH-RECONCILIATION.md:206-211 argues incognito is the legal lever that keeps the person's
account out of it.

**Competitor:** the reference MCP fetch server ships `--ignore-robots-txt` and a switchable UA;
`duckduckgo-mcp-server` documents that DDG's HTML endpoint 202s the `httpx` fingerprint and
offers a `curl` backend to get around it. fearch's honesty is a real differentiator against both.
What a competitor would notice first is that fearch's default search is worse than theirs
because it refuses to do what they do, and that the README leads with policy rather than with a
result. Lead with the fetch output and the Diagnosis; the policy is the second paragraph.

---

## Remove list (simplicity is a feature)

1. **Google AI Overview extraction** (`engines.ts:236-285`, fixture, tests, README/POLICY
   mentions). It is another model's unverified prose injected into the agent's context, parsed
   from A/B-tested markup, and it has a bug today. A search tool that returns links and snippets
   has done its job.
2. **`blocked_domains`** on the search tool. `site` covers the real need; if `allowed_domains`
   stays it must be sent to the engine (finding 2).
3. **Five of the eleven tuning flags**: `--browser-max-concurrent`, `--extension-connect-ms`,
   `--excerpt-chars`, `--max-bytes`, `--log-file`. Env-only or gone. The help text already calls
   them "settings nobody should need".
4. **`docs/research/*.md` (1,500 lines) and `docs/LEARNINGS.md` (485 lines)** out of the repo or
   into `docs/archive/`. RESEARCH-RECONCILIATION.md and CASES.md carry what was verified; the raw
   reports are provenance, not documentation, and a reader who opens `docs/` should meet POLICY,
   SPECTRUM, CASES, ROADMAP and nothing else.
5. **`evals/results/latest.json`** (stale, names removed providers). Keep the harness.
6. **The `human.homeUrl` "you press Enter in the browser" path** (`engines.ts:317-321,404-416`,
   `extension.ts:545-568`, `browser.ts:670-692`) once every client you care about can show a form.
   It exists for clients without elicitation; it is a second UI for the same decision.
7. **Dead code** in finding 10.

## Add list (what the mission demands that is missing)

1. RSS/Atom rendering (finding 3). General-purpose reading includes feeds.
2. A thin-content signal: when extracted text is under 1 KB from over 200 KB of HTML, say so in
   the header and try the browser once. Never hand back a footer as a page.
3. Labelled fallback from an unanswered/declined Google form to DuckDuckGo (finding 2).
4. Redacted engine-page dumps on zero parse, always (finding 2).
5. `robots_unavailable` diagnosis kind (finding 9).
6. `fearch clear-profile`, 0600 on the cookie jar, and the honest Session paragraph (finding 1).
7. Incognito on by default in the query form when the engine is Google and the person's own
   Chrome is in play (your own Report E reasoning).
8. For the friend: the MCPB bundle attached to releases and the Web Store extension (roadmap
   #15/#16). Until then, say in the README who this is for.

---

## Reconciling with `docs/` (where I disagree, and the call)

- **POLICY "Session" and "Identity" paragraphs vs the code** (finding 1). The code is the
  defensible behaviour (a passed check must be remembered per host); the document is wrong. Fix
  the document, add hygiene. Do not make ordinary reads ephemeral; you would lose the escalation
  memory the whole "headless until it matters" design depends on.
- **POLICY on robots.txt 4xx fail-closed.** Agree with the choice; disagree with reporting it as
  `robots_disallowed`. Rename the kind, keep the behaviour.
- **POLICY/RECONCILIATION on Content-Signal "honoured".** It is over-honoured (finding 5). A
  signal aimed at googlebot is not a signal to fearch.
- **ROADMAP "Search results carry a date" marked done.** Not true today. Either implement for
  Google or strike it from ROADMAP, AGENT-GUIDANCE and the tool description.
- **ROADMAP queued idea: DuckDuckGo Instant Answer API.** Say no. It is another surface, another
  parser, and an "answer box" in a tool whose value is honest links.
- **README/RECONCILIATION treat the AI Overview as a feature.** I would remove it (Remove list).
- **SPECTRUM's person-present rule.** I came in sceptical and left agreeing: the vendor
  documentation you verified (Copilot Cowork, Claude in Chrome, Gemini in Chrome) is the norm,
  and fearch is stricter on two axes. The one thing the argument implies and the product does not
  do is default incognito for Google (Add list 7).
- **ROADMAP v2.1 #1 (judged eval set).** Agree it is the most important item on the roadmap; the
  current substring harness with a stale result file is not evidence of quality. Rank it above
  the Web Store work.
- **AGENT-GUIDANCE.** Good as far as it goes. Add one line: "a page whose header says
  `direct (html/body)` and is under 1 KB is probably a JS app the tool could not read".

## Your mid-turn question

"If we don't get a response to an input from a user for a search, should we just default to
searching?" Yes, for engines that need no approval, and say so in the result (finding 2). The
rule "nothing is silently substituted" is about silence, not about substitution. Under
`--human-search`, where every engine needs approval, keep "nothing ran". Your incognito Google
"no results": most likely a consent or interstitial page in a fresh incognito context that
contained "did not match", parsed as zero results and read as an honest empty answer
(`engines.ts:492-494`). It cannot be confirmed because the page was not kept; that is the
argument for always dumping.

---

## Three things I would do first if this were mine

1. **Make the docs true.** Rewrite POLICY's Session paragraph, chmod the cookie jar, fix the live
   test and `server.json`, delete the stale eval result. Half a day; it protects the only thing
   fearch has that competitors do not.
2. **Never return garbage.** Yield-rule shell detection, feed rendering, the outline offset fix,
   always-dump on zero engine parse. One day. After this, every bad outcome is a Diagnosis or a
   labelled note, which is the mission stated in one sentence.
3. **Make search usable without a human at the keyboard.** Labelled DDG fallback on an
   unanswered or declined Google form, `allowed_domains` sent to the engine, AI Overview deleted,
   the date claim resolved one way or the other. One day. Then search is honestly "good enough",
   which is the most it can be without doing what you refuse to do.

---

## Appendix: dogfood log (rough edges in the order met)

- Google AI Overview text began with a fragment of my query (finding 6).
- Second parallel search went to DuckDuckGo with no note that Google was busy; provider choice
  under concurrency is invisible.
- Wikipedia read opened with `**Checked**` and a "Page version status" box.
- "Sections not shown" listed sections that were shown (finding 4); `Universal "" match`.
- Licence line reads `meta robots: max-image-preview:standard | CC BY-SA 4.0`; the first half is
  noise to an agent.
- MDN focus: stray `js` line before each fence (language label rendered as text).
- Pattern hint says `cursor=<position>` while footers say `984@read`; bare numbers work, fine.
- arXiv `/pdf/` fetched as `direct (pdf)` with title `(untitled)`; the abs page is a plain HTML
  read with broken `([v1)` markup, although README says arXiv goes through its API.
- Multi-URL failures render as `# (failed) url` plus a one-liner; single-URL failures render a
  full Diagnosis. Same error, two shapes.
- `site=docs.python.org` returned `/ja/3.16/` and `/pt-br/` pages with Japanese excerpts.
- `recency=m` Google query: "google: no results for this query" (your observation).
- `allowed_domains` with three domains: zero results, plus "retry after any cooldown named above"
  with no cooldown named.
- Zillow rendered over plain HTTP with runs of blank lines eating the budget.
- Focus `cancel` on asyncio → "Task object" (finding 8).
- `vitest.dev/` silently became a link-stripped `llms.txt` (finding 8).
- Mintlify docs leaked JSX (finding 8).
- YouTube → 154-char footer as content; hnrss → CDATA soup (finding 3).
- HN item page: `[[–]](javascript:void\(0\))` link residue.
- Udemy: `robots_disallowed` for a robots.txt 403 (finding 9).
- Glassdoor: bot check handed to a Chrome tab correctly; 96 s wall time for one CLI call, the
  log line saying so is at `warn` and the CLI is quiet by default, so a person sees nothing for a
  minute and a half. Print the handoff line to stderr unconditionally in the CLI.
- CLI: `fearch search` with no query exits 0 with a usage line; usage errors exit 2 elsewhere.
- CLI `--help` is 60 dense lines; the four flags a person needs are the first four. Consider a
  short `--help` and a `--help all`.
- `doctor` is excellent. It also phones httpbin.org (finding 9).
