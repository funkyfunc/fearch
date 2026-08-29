/** Opt-in live network tests: FEARCH_LIVE=1 npm run test:live */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { settingsFromEnv } from "../../src/config.js";
import { buildServer, createState, type AppState } from "../../src/server.js";

const live = !!process.env.FEARCH_LIVE;
const d = live ? describe : describe.skip;

let state: AppState;
let c: Client;
const text = (r: Awaited<ReturnType<Client["callTool"]>>) => (r.content as Array<{ type: string; text: string }>)[0].text;

d("live", () => {
  beforeAll(async () => {
    state = createState(settingsFromEnv({ ...process.env, FEARCH_NO_CACHE: "1", FEARCH_AUDIT_LOG: "stderr", FEARCH_UA_CONTACT: "fearch-tests@example.invalid" }));
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await buildServer(state).connect(st);
    c = new Client({ name: "live", version: "0" });
    await c.connect(ct);
  });
  afterAll(() => state?.cache.close());

  it("sends the honest user agent", async () => {
    const r = await c.callTool({ name: "fetch", arguments: { url: "https://httpbin.org/user-agent", mode: "raw" } });
    expect(text(r)).toContain("fearch/");
    expect(text(r)).not.toMatch(/Mozilla/);
  });

  it("refuses a robots-disallowed URL without touching the page", async () => {
    // GitHub disallows crawling of most HTML paths for generic agents; the API fast path is exempt.
    const r = await c.callTool({ name: "fetch", arguments: { url: "https://www.google.com/search?q=test" } });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain("kind: robots_disallowed");
  });

  it("reads native markdown, a Sphinx section, a GitHub README, and a PDF", async () => {
    const md = text(await c.callTool({ name: "fetch", arguments: { url: "https://gofastmcp.com/servers/tools", max_chars: 2000 } }));
    expect(md).toContain("source: direct (markdown)");
    const py = text(await c.callTool({ name: "fetch", arguments: { url: "https://docs.python.org/3/library/asyncio-task.html", mode: "section", query: "Timeouts", max_chars: 1500 } }));
    expect(py).toContain("## Timeouts");
    expect(py).toContain("asyncio.timeout");
    const gh = text(await c.callTool({ name: "fetch", arguments: { url: "https://github.com/deedy5/ddgs", max_chars: 1000 } }));
    expect(gh).toContain("source: github-readme");
    const pdf = text(await c.callTool({ name: "fetch", arguments: { url: "https://arxiv.org/pdf/2511.16397", max_chars: 800 } }));
    expect(pdf).toContain("(pdf)");
    expect(pdf).toContain("## Page");
  }, 120_000);

  it("diagnoses a blocked page instead of retrying", async () => {
    const r = await c.callTool({ name: "fetch", arguments: { url: "https://www.reddit.com/r/LocalLLaMA/" } });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/kind: (blocked_or_waf|captcha_or_challenge|robots_disallowed|rate_limited)/);
  }, 60_000);

  it("searches keylessly via the Exa hosted endpoint and the federation", async () => {
    const web = await c.callTool({ name: "search", arguments: { query: "python asyncio timeout context manager", max_results: 5 } });
    expect(web.isError).toBeFalsy();
    expect(text(web)).toMatch(/via [a-z+-]+/); // exa-hosted normally; federation when Exa's keyless tier is rate-limited
    const code = text(await c.callTool({ name: "search", arguments: { query: "duckduckgo metasearch python", kind: "code", max_results: 5 } }));
    expect(code).toContain("via github");
    expect(code).toContain("https://github.com/");
  }, 120_000);
});
