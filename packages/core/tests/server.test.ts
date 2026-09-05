import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { describe, expect, it } from "vitest";
import { settingsFromEnv } from "../src/config.js";
import { PendingCheck, type PageDoc } from "../src/fetch/pipeline.js";
import type { HandoffContinuation, Rendered } from "../src/fetch/browser.js";
import { RateLimited } from "../src/search/provider.js";
import { createApp, type App } from "../src/app.js";
import { buildServer } from "../src/server.js";

/** A person on call with no bridge extension: engine pages and checks go to a window of the installed Chrome. */
const NO_EXTENSION = {
  FEARCH_BROWSER: "auto",
  DISPLAY: ":0",
  FEARCH_CACHE_DIR: mkdtempSync(join(tmpdir(), "fearch-test-")),
};

const LONG_DOC =
  "# Title\n\nIntro.\n\n" +
  Array.from({ length: 14 }, (_, k) => k + 1)
    .map(
      (i) =>
        `## Section ${i}\n\n` +
        `Text about topic ${i}. `.repeat(40) +
        (i % 2 ? `\n\n\`\`\`python\nx = ${i}\n\`\`\`` : ""),
    )
    .join("\n\n");

function fakeState(): App {
  const settings = settingsFromEnv({
    FEARCH_NO_CACHE: "1",
    FEARCH_AUDIT_LOG: "off",
    FEARCH_LOG_LEVEL: "error",
  } as NodeJS.ProcessEnv);
  const state = createApp(settings);
  const fake = {
    async fetch(url: string): Promise<PageDoc> {
      return {
        url,
        finalUrl: url,
        title: "Title",
        source: "fake",
        markdown: LONG_DOC,
        note: "",
        robots: "allowed",
        licence: [],
        cached: false,
      };
    },
  };
  (state as unknown as { fetcher: unknown }).fetcher = fake;
  return state;
}

async function client(state: App): Promise<Client> {
  const server = buildServer(state);
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  const c = new Client({ name: "test", version: "0" });
  await c.connect(ct);
  return c;
}

const text = (r: Awaited<ReturnType<Client["callTool"]>>) =>
  (r.content as Array<{ type: string; text: string }>)[0].text;

describe("server", () => {
  it("lists two read-only tools with descriptions", async () => {
    const c = await client(fakeState());
    const tools = await c.listTools();
    const names = tools.tools.map((t) => t.name).sort();
    expect(names).toEqual(["fetch", "search"]);
    for (const t of tools.tools) {
      expect(t.annotations?.readOnlyHint).toBe(true);
      expect(t.annotations?.openWorldHint).toBe(true);
      expect((t.description ?? "").length).toBeGreaterThan(200);
    }
    const props = (tools.tools.find((t) => t.name === "fetch")!.inputSchema as { properties: Record<string, unknown> })
      .properties;
    for (const k of [
      "url",
      "urls",
      "mode",
      "query",
      "max_chars",
      "cursor",
      "include_links",
      "context_chars",
      "archive",
    ])
      expect(props).toHaveProperty(k);
    expect(Object.keys(props).length).toBe(9);
  });

  it("fetch truncates with outline + cursor and never splits fences; cursor continues", async () => {
    const c = await client(fakeState());
    const t = text(await c.callTool({ name: "fetch", arguments: { url: "https://x.test/p", max_chars: 1500 } }));
    expect(t.startsWith("# Title\nURL: https://x.test/p\nsource: fake · robots: allowed · chars 0–")).toBe(true);
    expect(t).toContain("Sections not shown:");
    expect(t).toMatch(/Continue with cursor="\d+@read"/);
    expect((t.match(/```/g) ?? []).length % 2).toBe(0);
    const cursor = /cursor="([^"]+)"/.exec(t)![1];
    const next = text(
      await c.callTool({ name: "fetch", arguments: { url: "https://x.test/p", max_chars: 1500, cursor } }),
    );
    expect(next).toContain(`chars ${cursor.split("@")[0]}–`);
    // a cursor from another view is ignored with a note rather than misapplied
    const wrong = text(
      await c.callTool({
        name: "fetch",
        arguments: { url: "https://x.test/p", mode: "focus", query: "topic 7", cursor },
      }),
    );
    expect(wrong).toContain("different view");
  });

  it("fetch focus, section, pattern", async () => {
    const c = await client(fakeState());
    const f = text(
      await c.callTool({
        name: "fetch",
        arguments: { url: "https://x.test/p", mode: "focus", query: "topic 7", max_chars: 1500 },
      }),
    );
    expect(f).toContain("## Section 7");
    expect(f).toContain("Focus: 'topic 7'");
    const s = text(
      await c.callTool({ name: "fetch", arguments: { url: "https://x.test/p", mode: "section", query: "Section 3" } }),
    );
    expect(s).toContain("## Section 3");
    expect(s).not.toContain("## Section 4");
    const missing = await c.callTool({
      name: "fetch",
      arguments: { url: "https://x.test/p", mode: "section", query: "nope zzz" },
    });
    expect(missing.isError).toBe(true);
    expect(text(missing)).toMatch(/Available sections: .*Section 1 · Section 2/);
    const p = text(
      await c.callTool({ name: "fetch", arguments: { url: "https://x.test/p", mode: "pattern", query: "x = 1\\d" } }),
    );
    expect(p).toContain("matches");
    expect(p).toMatch(/\[Position: \d+-\d+\]/);
    const noq = await c.callTool({ name: "fetch", arguments: { url: "https://x.test/p", mode: "focus" } });
    expect(noq.isError).toBe(true);
    expect(text(noq)).toContain("needs `query`");
  });

  it("fetch batch splits the budget; requires a url", async () => {
    const c = await client(fakeState());
    const t = text(await c.callTool({ name: "fetch", arguments: { urls: ["https://a.test/", "https://b.test/"] } }));
    expect(t.split("=====").length).toBe(2);
    expect(t).toContain("URL: https://a.test/");
    const none = await c.callTool({ name: "fetch", arguments: {} });
    expect(none.isError).toBe(true);
  });

  it("search with no providers explains itself", async () => {
    const state = fakeState();
    (state.search as unknown as { web: unknown[] }).web = [];
    const c = await client(state);
    const r = await c.callTool({ name: "search", arguments: { query: "anything" } });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain("No results (");
  });
});

describe("stdio", () => {
  it("keeps stdout pure JSON-RPC and answers initialize + tools/list", async () => {
    const proc = spawn(process.execPath, ["--import", "tsx", "packages/core/src/cli.ts"], {
      env: { ...process.env, FEARCH_NO_CACHE: "1", FEARCH_LOG_LEVEL: "debug", FEARCH_AUDIT_LOG: "stderr" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const lines = createInterface({ input: proc.stdout });
    const queue: string[] = [];
    const waiters: Array<(l: string) => void> = [];
    lines.on("line", (l) => (waiters.length ? waiters.shift()!(l) : queue.push(l)));
    const next = () =>
      queue.length ? Promise.resolve(queue.shift()!) : new Promise<string>((res) => waiters.push(res));
    const send = (m: unknown) => proc.stdin.write(JSON.stringify(m) + "\n");
    // Every stdout line must parse as JSON-RPC; server-initiated messages (the id-0-burning ping)
    // are answered or skipped the way a real client would, and responses are returned.
    const nextResponse = async (): Promise<{
      id: number;
      result: { serverInfo?: { name: string }; tools?: Array<{ name: string }> };
    }> => {
      for (;;) {
        const m = JSON.parse(await next()); // throws if any non-JSON reached stdout
        if (m.method === "ping") {
          send({ jsonrpc: "2.0", id: m.id, result: {} });
          continue;
        }
        if (m.method) continue;
        return m;
      }
    };
    let stderr = "";
    proc.stderr.on("data", (d) => (stderr += d));
    try {
      send({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } },
      });
      const first = await nextResponse();
      expect(first.id).toBe(1);
      expect(first.result.serverInfo?.name).toBe("fearch");
      send({ jsonrpc: "2.0", method: "notifications/initialized" });
      send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
      const second = await nextResponse();
      expect(second.result.tools?.map((t: { name: string }) => t.name).sort()).toEqual(["fetch", "search"]);
      expect(stderr).toContain("User-Agent: fearch/");
    } finally {
      proc.kill();
    }
  }, 30_000);
});

describe("query confirmation (--human-search)", () => {
  it("asks the client with the query in an editable field and runs what the person accepted", async () => {
    const state = createApp(
      settingsFromEnv({
        FEARCH_NO_CACHE: "1",
        FEARCH_AUDIT_LOG: "off",
        FEARCH_LOG_LEVEL: "error",
        FEARCH_HUMAN_SEARCH: "1",
        FEARCH_ENGINES: "google",
        ...NO_EXTENSION,
      } as NodeJS.ProcessEnv),
    );
    const asked: Array<{ message: string; schema: unknown }> = [];
    const ran: Array<{ query: string; submitted?: boolean }> = [];
    // a fake engine that records what it was asked to run
    const engine = (state.search as unknown as { engines: Array<{ search: unknown; name: string }> }).engines.find(
      (e) => e.name === "google",
    )!;
    (state.search as unknown as { web: unknown[] }).web = [engine];
    engine.search = async (q: { query: string }, o?: { submittedByPerson?: boolean }) => {
      ran.push({ query: q.query, submitted: o?.submittedByPerson });
      return { results: [{ title: "t", url: "https://x.test/1", snippet: "s", provider: "google" }] };
    };
    const server = buildServer(state);
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st);
    const c = new Client({ name: "test", version: "0" }, { capabilities: { elicitation: {} } });
    c.setRequestHandler("elicitation/create", async (req) => {
      asked.push({ message: req.params.message, schema: req.params.requestedSchema });
      return { action: "accept" as const, content: { query: "edited query", google: true, ask_again: true } };
    });
    await c.connect(ct);
    const r = await c.callTool({ name: "search", arguments: { query: "original query" } });
    expect(asked.length).toBe(1);
    expect(asked[0].message).toContain("Run this search as you?");
    const schema = JSON.stringify(asked[0].schema);
    expect(schema).toContain('"default":"original query"');
    expect(schema).not.toContain('"enum"'); // one engine: nothing to pick
    expect(schema).toContain('"ask_again"');
    expect(schema).toContain('"title":"Incognito"'); // no extension here: the alternative is fearch's own profile
    expect(schema).toContain("fearch's own Chrome profile");
    expect(ran).toEqual([{ query: "edited query", submitted: true }]);
    expect(text(r)).toContain("https://x.test/1");
    await c.close();
  });
});

/** A fetcher whose first read hits a bot check: it suspends like the browser tier does and resumes on the answer. */
function checkingFetcher(state: App) {
  const answers: string[] = [];
  let cancelled = 0;
  let fetches = 0;
  const fake = {
    async fetch(url: string): Promise<PageDoc> {
      fetches++;
      const cont: HandoffContinuation = {
        async resume(answer) {
          answers.push(answer);
          const rendered: Rendered = {
            html: `<html><body><h1>Behind the check</h1><p>${answer === "accept" ? "You passed it." : "Still the check page."}</p></body></html>`,
            finalUrl: url,
            status: 200,
            salvaged: false,
            usedSession: false,
            handedOff: answer === "accept",
            handoffWhere: "a window",
            handoff: answer === "accept" ? "passed" : "declined",
          };
          return rendered;
        },
        async cancel() {
          cancelled++;
        },
      };
      const asked = await state.gate.ask!({ url, where: "a browser window on your screen" }, cont);
      if (typeof asked === "object")
        throw new PendingCheck(asked.deferred, url, "a browser window on your screen", [
          "direct: captcha_or_challenge",
          "browser: handed to you",
        ]);
      return {
        url,
        finalUrl: url,
        title: "No prompt",
        source: "fake",
        markdown: `# No prompt (${asked})`,
        note: "",
        robots: "allowed",
        licence: [],
        cached: false,
      };
    },
    async completePending(url: string, r: Rendered, attempts: string[]): Promise<PageDoc> {
      const passed = r.handoff === "passed";
      return {
        url,
        finalUrl: url,
        title: "Behind the check",
        source: passed ? "browser, bot check cleared in your browser" : "browser",
        markdown: passed ? "# Behind the check\n\nYou passed it." : "# Still the check page",
        note: attempts.join("; "),
        robots: "allowed",
        licence: [],
        cached: false,
      };
    },
  };
  (state as unknown as { fetcher: unknown }).fetcher = fake;
  return { answers, cancelled: () => cancelled, fetches: () => fetches };
}

describe("the challenge prompt (handoff gate)", () => {
  it("asks an elicitation-capable client before a check is surfaced; yes and no resume the render, silence leaves it waiting", async () => {
    const state = createApp(
      settingsFromEnv({
        FEARCH_NO_CACHE: "1",
        FEARCH_AUDIT_LOG: "off",
        FEARCH_LOG_LEVEL: "error",
        FEARCH_HANDOFF_TIMEOUT_MS: "150",
      } as NodeJS.ProcessEnv),
    );
    const fetcher = checkingFetcher(state);
    const server = buildServer(state);
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st);
    const c = new Client({ name: "test", version: "0" }, { capabilities: { elicitation: {} } });
    const seen: string[] = [];
    let reply: "accept" | "decline" | "cancel" | "never" = "accept";
    c.setRequestHandler("elicitation/create", async (req) => {
      seen.push(req.params.message);
      if (reply === "never") return new Promise(() => {});
      return { action: reply };
    });
    await c.connect(ct);
    const url = "https://www.google.com/sorry/x";
    const yes = await c.callTool({ name: "fetch", arguments: { url } });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain("www.google.com");
    expect(seen[0]).toContain("Open it for you in a browser window on your screen?");
    expect(fetcher.answers).toEqual(["accept"]);
    expect(text(yes)).toContain("You passed it.");
    expect(text(yes)).toContain("handed to you");
    expect(state.pending.size).toBe(0);

    reply = "decline";
    const no = await c.callTool({ name: "fetch", arguments: { url } });
    expect(fetcher.answers).toEqual(["accept", "declined"]);
    expect(text(no)).toContain("Still the check page");

    // Dismissed (the client's `cancel`): not a no. The page keeps waiting, and the next fetch of the
    // same URL asks again about that waiting page instead of rendering it afresh.
    reply = "cancel";
    const dismissed = await c.callTool({ name: "fetch", arguments: { url } });
    expect(dismissed.isError).toBe(true);
    expect(text(dismissed)).toContain("dismissed without an answer");
    expect(text(dismissed)).toContain("waits in the background");
    expect(state.pending.size).toBe(1);
    const fetchesBefore = fetcher.fetches();
    reply = "accept";
    const late = await c.callTool({ name: "fetch", arguments: { url } });
    expect(fetcher.fetches()).toBe(fetchesBefore); // re-offered, not re-rendered
    expect(fetcher.answers).toEqual(["accept", "declined", "accept"]);
    expect(text(late)).toContain("You passed it.");
    expect(state.pending.size).toBe(0);

    reply = "never";
    const started = Date.now();
    const silence = await c.callTool({ name: "fetch", arguments: { url } });
    expect(Date.now() - started).toBeLessThan(5000);
    expect(silence.isError).toBe(true);
    expect(text(silence)).toContain("nobody answered within");
    expect(text(silence)).toContain("call fetch again on this same URL");
    expect(fetcher.answers).toHaveLength(3); // nothing resumed without an answer
    expect(state.pending.size).toBe(1); // the check waits for the person until it expires
    await c.close();
    await state.close(); // shutdown cancels what is still waiting
    expect(state.pending.size).toBe(0);
    expect(fetcher.cancelled()).toBe(1);
  });

  it("is unavailable for clients without the elicitation capability, and sends them nothing", async () => {
    const state = fakeState();
    const fetcher = checkingFetcher(state);
    const server = buildServer(state);
    // Count outgoing server→client requests: none may be sent to a client that cannot show a prompt.
    const inner = server.server as unknown as { request: (...a: unknown[]) => Promise<unknown> };
    const original = inner.request.bind(server.server);
    let sent = 0;
    inner.request = (...a: unknown[]) => {
      if ((a[0] as { method?: string })?.method === "elicitation/create") sent++;
      return original(...a);
    };
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st);
    const c = new Client({ name: "test", version: "0" });
    await c.connect(ct);
    const r = await c.callTool({ name: "fetch", arguments: { url: "https://x.test/" } });
    expect(text(r)).toContain("No prompt (unavailable)");
    expect(fetcher.answers).toEqual([]);
    expect(sent).toBe(0);
    expect(state.pending.size).toBe(0);
    await c.close();
  });
});

describe("query confirmation — nobody answers", () => {
  it("gives up after the handoff timeout without running anything under the person's name", async () => {
    const state = createApp(
      settingsFromEnv({
        FEARCH_NO_CACHE: "1",
        FEARCH_AUDIT_LOG: "off",
        FEARCH_LOG_LEVEL: "error",
        FEARCH_HUMAN_SEARCH: "1",
        FEARCH_ENGINES: "google",
        ...NO_EXTENSION,
        FEARCH_HANDOFF_TIMEOUT_MS: "150",
      } as NodeJS.ProcessEnv),
    );
    const engine = (state.search as unknown as { engines: Array<{ search: unknown; name: string }> }).engines.find(
      (e) => e.name === "google",
    )!;
    (state.search as unknown as { web: unknown[] }).web = [engine];
    let ran = 0;
    engine.search = async () => {
      ran++;
      return { results: [] };
    };
    const server = buildServer(state);
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st);
    const c = new Client({ name: "test", version: "0" }, { capabilities: { elicitation: {} } });
    c.setRequestHandler("elicitation/create", () => new Promise(() => {})); // the person is away
    await c.connect(ct);
    const started = Date.now();
    const r = await c.callTool({ name: "search", arguments: { query: "quiet query" } });
    expect(Date.now() - started).toBeLessThan(5000); // the SDK's own 60 s timeout is not what bounds this
    expect(ran).toBe(0); // nothing ran under the person's name without their answer
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/nobody answered within \d+ s \(asked at \d\d:\d\d UTC\)/); // fearch's own words, not the SDK shim's
    expect(text(r)).not.toContain("Fulfilling input required");
    await c.close();
  });

  it("a dismissed form (the client's cancel) is not a no: the search says so and nothing runs", async () => {
    const state = createApp(
      settingsFromEnv({
        FEARCH_NO_CACHE: "1",
        FEARCH_AUDIT_LOG: "off",
        FEARCH_LOG_LEVEL: "error",
        FEARCH_ENGINES: "google",
        ...NO_EXTENSION,
      } as NodeJS.ProcessEnv),
    );
    const engine = (state.search as unknown as { engines: Array<{ search: unknown; name: string }> }).engines.find(
      (e) => e.name === "google",
    )!;
    (state.search as unknown as { web: unknown[] }).web = [engine];
    let ran = 0;
    engine.search = async () => {
      ran++;
      return { results: [] };
    };
    const c = await elicitingClient(state, async () => ({ action: "cancel" as const }));
    const r = await c.callTool({ name: "search", arguments: { query: "dismissed query" } });
    expect(ran).toBe(0);
    expect(r.isError).toBe(true);
    expect(text(r)).toContain("dismissed without an answer");
    expect(text(r)).not.toMatch(/declined/);
    await c.close();
  });

  it("declining the form is an answer: the search stops with a note, nothing runs", async () => {
    const state = createApp(
      settingsFromEnv({
        FEARCH_NO_CACHE: "1",
        FEARCH_AUDIT_LOG: "off",
        FEARCH_LOG_LEVEL: "error",
        FEARCH_ENGINES: "google",
        ...NO_EXTENSION,
      } as NodeJS.ProcessEnv),
    );
    const engine = (state.search as unknown as { engines: Array<{ search: unknown; name: string }> }).engines.find(
      (e) => e.name === "google",
    )!;
    (state.search as unknown as { web: unknown[] }).web = [engine];
    let ran = 0;
    engine.search = async () => {
      ran++;
      return { results: [] };
    };
    const c = await elicitingClient(state, async () => ({ action: "decline" as const }));
    const r = await c.callTool({ name: "search", arguments: { query: "private query" } });
    expect(ran).toBe(0);
    expect(text(r)).toMatch(/declined/i);
    await c.close();
  });
});

async function elicitingClient(
  state: App,
  answer: (req: {
    params: { message: string; requestedSchema: unknown };
  }) => Promise<{ action: "accept" | "decline" | "cancel"; content?: Record<string, unknown> }>,
): Promise<Client> {
  const server = buildServer(state);
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  const c = new Client({ name: "test", version: "0" }, { capabilities: { elicitation: {} } });
  c.setRequestHandler("elicitation/create", answer as never);
  await c.connect(ct);
  return c;
}

describe("query confirmation across engines", () => {
  it("a bot check on the first engine asks about the second with the reason; the first is not run twice", async () => {
    const state = createApp(
      settingsFromEnv({
        FEARCH_NO_CACHE: "1",
        FEARCH_AUDIT_LOG: "off",
        FEARCH_LOG_LEVEL: "error",
        FEARCH_ENGINES: "duckduckgo,google",
        ...NO_EXTENSION,
      } as NodeJS.ProcessEnv),
    );
    const engines = (state.search as unknown as { engines: Array<{ search: unknown; name: string }> }).engines;
    const ddg = engines.find((e) => e.name === "duckduckgo")!;
    const google = engines.find((e) => e.name === "google")!;
    (state.search as unknown as { web: unknown[] }).web = [ddg, google];
    const ran: string[] = [];
    ddg.search = async () => {
      ran.push("duckduckgo");
      throw new RateLimited("DuckDuckGo showed its bot check");
    };
    google.search = async (q: { query: string }) => {
      ran.push(`google:${q.query}`);
      return { results: [{ title: "t", url: "https://x.test/g", snippet: "s", provider: "google" }] };
    };
    const asked: Array<{ message: string; schema: string }> = [];
    const c = await elicitingClient(state, async (req) => {
      asked.push({ message: req.params.message, schema: JSON.stringify(req.params.requestedSchema) });
      return { action: "accept", content: { query: "second query", google: true, ask_again: true } };
    });
    const r = await c.callTool({ name: "search", arguments: { query: "first query" } });
    expect(asked).toHaveLength(1);
    expect(asked[0].message).toContain("bot check");
    expect(asked[0].schema).not.toContain("Search on Google"); // DuckDuckGo was tried: only Google is left to offer
    expect(asked[0].schema).toContain('"default":"first query"');
    expect(ran).toEqual(["duckduckgo", "google:second query"]);
    expect(text(r)).toContain("https://x.test/g");
    expect(text(r)).toContain("bot check"); // the first engine's failure is still reported
    await c.close();
  });
});
