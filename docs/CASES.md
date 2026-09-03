# Case register

The decisions the posture documents (`POLICY.md`, `SPECTRUM.md`) rest on, one entry each, so a
claim about "the courts" can be checked in a minute. This is a register, not legal advice, and not
a summary of the law: each entry says what the court decided, what it did not decide, why it
matters to a locally-run, self-identifying tool that opens engine pages in the person's own browser,
and how the entry was verified. Add a case only with a primary source; mark the verification.

Verification stamps: **P** — read in the opinion/order itself on the date given; **S** — several
independent secondary accounts agree, opinion not read; **U** — unverified.

## United States

| Case | Court · date | Held | Did not hold | Why it matters here | Verified |
| --- | --- | --- | --- | --- | --- |
| *Van Buren v. United States*, No. 19-783 | US Supreme Court · 2021-06-03 · [opinion](https://www.supremecourt.gov/opinions/20pdf/19-783_k53l.pdf) | CFAA "exceeds authorized access" is a gates-up-or-down question: one either can or cannot access a system or an area within it. Using access one has for an improper purpose is not a CFAA violation. | Whether purely public pages are "authorized" (left to *hiQ* on remand). | Reading public pages, and reading them for an AI's purposes, is not what the CFAA reaches. | P 2026-09-02 |
| *hiQ Labs v. LinkedIn* (CFAA) | 9th Cir. · 2019-09-09, reaffirmed on remand 2022-04-18 · [2022 opinion](https://law.justia.com/cases/federal/appellate-courts/ca9/17-16783/17-16783-2022-04-18.html) | Scraping public profiles behind no authentication gate is likely not "without authorization" under the CFAA; preliminary injunction for hiQ affirmed. | Anything about terms of service, or about logged-in access. | The CFAA half of the story: public pages are open to automated readers as far as the statute goes. | S |
| *hiQ Labs v. LinkedIn* (contract) | N.D. Cal. · 2022-11-04 order; consent judgment 2022-12-06 · [order](https://caselaw.findlaw.com/court/us-dis-crt-n-d-cal/2182242.html) | Summary judgment for LinkedIn: hiQ breached the User Agreement (scraping while bound by it, and "turker" fake accounts). Consent judgment: $500,000 and a permanent injunction against scraping. | Nothing new on the CFAA. | The contract half: a platform's terms bind those bound by them, and the CFAA win did not save hiQ from that. | P (order) / S (judgment) 2026-09-02 |
| *Meta Platforms v. Bright Data* | N.D. Cal. (Chen, J.) · 2024-01-23 | Summary judgment for Bright Data: Meta's terms govern an account holder's use of the account; scraping public pages **logged off** is not a breach. | That logged-in scraping is fine (it found none), or anything under the CFAA. | Whether the person's *account* is in the picture is what decides whether a platform's terms bind a query. The strongest argument for `--incognito` on engine pages. | S (Quinn Emanuel, Farella, Lowenstein, Courthouse News) |
| *X Corp. v. Bright Data* | N.D. Cal. (Alsup, J.) · 2024-05-09 | Dismissed X's state-law contract and tort claims over scraping of public posts as preempted by the Copyright Act; terms cannot be used to create copyright-like control over public content X does not own. | That terms never bind; the ruling is about state-law claims used as a scraping ban. | Limits how far "our terms forbid it" can be turned into damages over public pages. | S (Skadden; the Justia docket link in Report E is an order on personal jurisdiction, not this ruling) |
| *Ryanair v. Booking.com*, No. 20-1191 | D. Del. (Bryson, J.) · jury verdict 2024-07-18; JMOL for Booking.com 2025-01 · [opinion](https://www.ded.uscourts.gov/sites/ded/files/opinions/20-1191_1.pdf) | Jury found CFAA liability for scraping behind a "myRyanair" login; the court then entered judgment as a matter of law for Booking.com because Ryanair proved no $5,000 CFAA "loss". | Whether logged-in scraping by a third party is authorized (the jury said no; the reversal was on loss). | The logged-in fact pattern is the one that reached a jury. Stay out of the person's accounts unless they put them there. | P 2026-09-02 |
| *Amazon.com Services v. Perplexity AI*, No. 26-1444 | 9th Cir. (M. Smith, J.) · 2026-08-04 · [opinion](https://cdn.ca9.uscourts.gov/datastore/opinions/2026/08/04/26-1444.pdf) | Preliminary injunction vacated: the CFAA reaches "whoever … intentionally accesses"; the AI assistant, "however advanced", is a tool, not a person; requests came from the user's browser and Perplexity's servers never touched Amazon's, so the *user* accessed Amazon, not Perplexity. Rule of lenity: extending the CFAA here could criminalise the users themselves. | "We do not establish a new legal regime governing agentic AI." Tied to this architecture; terms-of-service enforcement expressly untouched (footnote); the user-agent-string dispute (Perplexity chose not to send one; whether it altered it after being blocked is disputed) not decided. | The architecture the court relied on is the extension tier's: the person's own browser, a local tool, no vendor server in the path. A CFAA "access" holding, not a licence; the identification question it left open is the one this project answers by choice. | P 2026-09-01 |
| *Google LLC v. SerpApi*, No. 5:25-cv-10826 | N.D. Cal. (Gonzalez Rogers, C.J.) · filed 2025-12-19 · [complaint](https://storage.googleapis.com/gweb-uniblog-publish-prod/documents/Google_v._SerpApi__Complaint.pdf); DMCA claims dismissed 2026-07-20 | Complaint: SerpApi circumvented "SearchGuard" (JS challenges, browser checks) with proxies, fabricated fingerprints and CAPTCHA solving at hundreds of millions of queries a day — pleaded as DMCA §1201 circumvention and trafficking. Order: the §1201(a) claims dismissed (blocking bots from results is not, by itself, an access control on a copyrighted work), with leave to amend; other claims continue. | That scraping Google is lawful; the case is alive on other claims. | Names precisely what fearch never does: stealth, proxies, fingerprints, CAPTCHA solving, volume. The dismissal weakens §1201 as an anti-scraping tool; it says nothing about terms. | P (complaint) / S (dismissal: SEJ, Techdirt, Yahoo Finance) 2026-09-02 |
| *Meta Platforms v. BrandTotal*, No. 20-cv-07182 | N.D. Cal. (Spero, C.M.J.) · 2022-05-27 (order, filed 2022-06-06) · [order](https://law.justia.com/cases/federal/district-courts/california/candce/3:2020cv07182/367276/344/) | Summary judgment for Meta on breach of contract: BrandTotal's UpVoice extension collected ad data from logged-in Facebook sessions and BrandTotal itself was bound by Meta's terms; CFAA claims as to logged-in collection also went Meta's way in part. | That a browser extension per se is unlawful. | A vendor running an extension in users' *logged-in* sessions, commercialising what it collects, is the fact pattern to stay away from; fearch's extension collects nothing for anyone but the person running it. | P (order header and overview read) / S (holdings) 2026-09-02 |
| *Berman v. Freedom Financial Network*, No. 20-16900 | 9th Cir. · 2022-04-05 · [opinion](https://caselaw.findlaw.com/court/us-9th-circuit/1925200.html) | No agreement to arbitrate: terms hyperlinked in fine print without conspicuous notice do not bind a website user (browsewrap needs reasonably conspicuous notice or actual knowledge). | Anything about scraping. | The logged-off visitor's position: terms a person never saw or agreed to rarely bind them. | S (FindLaw text available; not read in full) |
| *Freeman v. DirecTV*, 457 F.3d 1001 | 9th Cir. · 2006 | No civil aiding-and-abetting liability under the Wiretap Act / Stored Communications Act. | Anything about the CFAA — Report E cited it for that; wrong statute. | Only as a caution about citations. | S |

## European Union

| Case | Court · date | Held | Did not hold | Why it matters here | Verified |
| --- | --- | --- | --- | --- | --- |
| *Innoweb v. Wegener*, C-202/12 | CJEU (5th Ch.) · 2013-12-19 · [judgment](https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX:62012CJ0202) | A *dedicated meta search engine* that translates users' queries to a third-party database in real time, searches all of it, and presents results in its own interface "re-utilises" a substantial part of that database (Art. 7 of Directive 96/9). | That an individual's own searches re-utilise anything. | The EU database right bites the *operator* of a meta-search service, not the person searching. fearch operates no service. | P 2026-09-02 |
| *CV-Online Latvia v. Melons*, C-762/19 | CJEU (5th Ch.) · 2021-06-03 · [judgment](https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX:62019CJ0762) | An aggregator's extraction/re-utilisation infringes the sui generis right only where it risks the maker's substantial investment (significant detriment, qualitatively or quantitatively); a balance with competition. | — | Narrows *Innoweb*: transient, insubstantial retrieval for one person is far from the line. | P 2026-09-02 |
| *Ryanair v. PR Aviation*, C-30/14 | CJEU · 2015-01-15 · [judgment](https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=celex:62014CJ0030) | Where a database enjoys neither copyright nor the sui generis right, its maker may restrict use by contract under national law. | Whether such terms bind consumers (Directive 93/13 applies). | Terms remain the operative lever in the EU too. | S |
| *Kneschke v. LAION*, 5 U 104/24 | OLG Hamburg · 2025-12-10 | Germany's first appellate ruling on TDM exceptions: LAION's dataset creation fell within the research exception; machine-readable opt-outs (robots.txt, TDM-RP, metadata) are the effective way to reserve rights online. | Anything about real-time, non-training retrieval. | Why fearch reads and honours machine-readable opt-outs even though it does not train: in the EU they are the rights-reservation mechanism. | S (Bird & Bird, DLA Piper, Technology's Legal Edge, InsideTechLaw) |

## United Kingdom

| Case | Court · date | Held | Did not hold | Why it matters here | Verified |
| --- | --- | --- | --- | --- | --- |
| *DPP v. Lennon* [2006] EWHC 1201 (Admin) | Divisional Court · 2006 | Connecting a server to the internet implies consent to receive the kind of communications it is set up to process; consent is vitiated by communications sent to overwhelm it (five million emails). | — | Ordinary, paced requests to a public engine sit inside implied consent; volume and intent to impair are what remove it. | S |
| *Getty Images v. Stability AI* [2025] EWHC | High Court (Joanna Smith, J.) · 2025-11-13 | Secondary copyright claim failed: model weights are not an "infringing copy"; limited trade-mark findings. | Anything about scraping or retrieval. | Only for completeness on the UK AI landscape; no bearing on fetching. | S (Latham, Mayer Brown, Ropes & Gray, Katten) |

## Statutes and terms referenced

- Google Terms of Service (policies.google.com/terms, read 2026-09-01): prohibits "using automated
  means to access content from any of our services in violation of the machine-readable
  instructions on our web pages (for example, robots.txt files…)", "hiding or misrepresenting who
  you are in order to violate these terms", and "providing services that encourage others to violate
  these terms". The older "automated queries of any sort" wording is from the 2002 terms.
- google.com/robots.txt (read 2026-09-01): `User-agent: *` … `Disallow: /search` (with `/search/about`
  and `/search/howsearchworks` allowed).
- Microsoft Services Agreement (read 2026-09-02): "Don't circumvent any restrictions on access to,
  usage, or availability of the Services (e.g. … impermissible scraping)"; scraping of its AI
  services barred separately. No "bots, spiders, meta-search" wording in the live text.
- DuckDuckGo Terms of Service (read 2026-09-02): no automation, bot, scraping or rate clause.
  lite.duckduckgo.com/lite/ is robots-permitted.
- OpenAI crawler docs (read 2026-09-01): ChatGPT-User "is not used for crawling the web in an
  automatic fashion. Because these actions are initiated by a user, robots.txt rules may not apply";
  it self-identifies in the UA and publishes IP ranges.
- Anthropic (support.claude.com/en/articles/8896518, read 2026-09-01): Claude-User lets site owners
  control access "through these user-initiated requests".
