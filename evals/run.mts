/**
 * Eval harness (live network): for each question, run `search` then `fetch` (focus mode on the
 * expected page, or the first result from the expected host), and grade whether the answer phrases
 * are present. Prints a table and writes evals/results/latest.json with the config that produced it.
 *
 *   npm run eval            # all
 *   npm run eval -- py-     # ids starting with "py-"
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createState, renderDoc } from "../packages/core/src/server.ts";

interface Q {
  id: string;
  question: string;
  query: string;
  kind?: "web" | "code" | "qa" | "packages" | "docs";
  expect_host: string;
  must_contain: string[];
  must_not_contain?: string[];
}

const here = dirname(fileURLToPath(import.meta.url));
const questions = JSON.parse(readFileSync(join(here, "questions.json"), "utf8")) as Q[];
const filter = process.argv[2];
const state = createState();
const hostMatches = (url: string, host: string) => {
  const h = new URL(url).hostname;
  return h === host || h.endsWith("." + host);
};

interface R {
  id: string;
  ok: boolean;
  searchMs: number;
  fetchMs: number;
  provider: string;
  hit?: string;
  source?: string;
  missing: string[];
  forbidden: string[];
  error?: string;
}

const results: R[] = [];
let fellBack = 0;
for (const q of questions.filter((q) => !filter || q.id.startsWith(filter))) {
  const r: R = { id: q.id, ok: false, searchMs: 0, fetchMs: 0, provider: "", missing: [], forbidden: [] };
  try {
    let t = Date.now();
    const o = await state.search.search({ query: q.query, maxResults: 6, kind: q.kind });
    r.searchMs = Date.now() - t;
    r.provider = o.providers.map((p) => p.name).join("+");
    if (o.fellBackToFederation) fellBack++;
    const hit = o.results.find((x) => hostMatches(x.url, q.expect_host)) ?? o.results[0];
    r.hit = hit?.url;
    if (!hit) throw new Error("no results");
    t = Date.now();
    const doc = await state.fetcher.fetch(hit.url);
    const text = renderDoc(doc, { mode: "focus", query: q.question, maxChars: 6000, includeLinks: false });
    r.fetchMs = Date.now() - t;
    r.source = doc.source;
    r.missing = q.must_contain.filter((s) => !text.includes(s));
    r.forbidden = (q.must_not_contain ?? []).filter((s) => text.includes(s));
    r.ok = hostMatches(hit.url, q.expect_host) && !r.missing.length && !r.forbidden.length;
  } catch (e) {
    r.error = (e as Error & { diagnosis?: { kind: string } }).diagnosis?.kind ?? (e as Error).message.slice(0, 80);
  }
  results.push(r);
  const flag = r.ok ? "PASS" : "FAIL";
  console.log(`${flag} ${q.id.padEnd(28)} ${String(r.searchMs).padStart(5)}ms/${String(r.fetchMs).padStart(5)}ms ${r.provider.padEnd(14)} ${(r.source ?? r.error ?? "").padEnd(24)} ${r.hit ?? ""}${r.missing.length ? `  missing: ${r.missing.join(", ")}` : ""}${r.forbidden.length ? `  forbidden: ${r.forbidden.join(", ")}` : ""}`);
}

const passed = results.filter((r) => r.ok).length;
console.log(`\n${passed}/${results.length} passed`);
if (fellBack) {
  console.log(`NOTE: ${fellBack} web queries fell back to first-party APIs because no general-web provider answered (Exa's keyless tier rate-limits after bursts). These results measure the fallback path, not the primary one; wait an hour or set EXA_API_KEY/TAVILY_API_KEY to measure the primary path.`);
}
mkdirSync(join(here, "results"), { recursive: true });
writeFileSync(
  join(here, "results", "latest.json"),
  JSON.stringify({ ts: new Date().toISOString(), version: state.settings.version, robotsPolicy: state.settings.robotsPolicy, browser: state.settings.browser, providers: state.search.describe(), webFallbacks: fellBack, passed, total: results.length, results }, null, 2),
);
await state.browser.close();
state.cache.close();
process.exit(passed === results.length ? 0 : 1);
