import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { describe, expect, it } from "vitest";
import { settingsFromEnv } from "../src/config.js";
import type { PageDoc } from "../src/fetch/pipeline.js";
import { createApp, type App } from "../src/app.js";
import { buildServer } from "../src/server.js";

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
        FEARCH_BROWSER: "headed",
      } as NodeJS.ProcessEnv),
    );
    const asked: Array<{ message: string; schema: unknown }> = [];
    const ran: string[] = [];
    // a fake engine that records what it was asked to run
    const engine = (
      state.search as unknown as { engines: Array<{ confirmQuery?: unknown; search: unknown; name: string }> }
    ).engines.find((e) => e.name === "google")!;
    (state.search as unknown as { web: unknown[] }).web = [engine];
    engine.search = async (q: { query: string }) => {
      const answer = await (engine.confirmQuery as (e: string, q: string) => Promise<{ query: string } | string>)(
        "Google",
        q.query,
      );
      if (typeof answer === "string") throw new Error(answer);
      ran.push(answer.query);
      return { results: [{ title: "t", url: "https://x.test/1", snippet: "s", provider: "google" }] };
    };
    const server = buildServer(state);
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st);
    const c = new Client({ name: "test", version: "0" }, { capabilities: { elicitation: {} } });
    c.setRequestHandler(ElicitRequestSchema, async (req) => {
      asked.push({ message: req.params.message, schema: req.params.requestedSchema });
      return { action: "accept" as const, content: { query: "edited query" } };
    });
    await c.connect(ct);
    const r = await c.callTool({ name: "search", arguments: { query: "original query" } });
    expect(asked.length).toBe(1);
    expect(asked[0].message).toContain("Google");
    expect(JSON.stringify(asked[0].schema)).toContain('"default":"original query"');
    expect(ran).toEqual(["edited query"]);
    expect(text(r)).toContain("https://x.test/1");
    await c.close();
  });
});

describe("handoff elicitation", () => {
  it("notifies an elicitation-capable client when a challenge is handed to the person, and dismisses it when the handoff ends", async () => {
    const state = fakeState();
    const server = buildServer(state);
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st);
    const c = new Client({ name: "test", version: "0" }, { capabilities: { elicitation: {} } });
    const seen: string[] = [];
    let cancelled = false;
    c.setRequestHandler(ElicitRequestSchema, async (req, extra) => {
      seen.push(req.params.message);
      // Hold the prompt open the way a real client would, until the server cancels it.
      return await new Promise((resolve) => {
        extra.signal.addEventListener("abort", () => {
          cancelled = true;
          resolve({ action: "cancel" as const });
        });
      });
    });
    await c.connect(ct);

    state.events.emit("handoff", { url: "https://www.google.com/sorry/x", where: "a browser window on your screen" });
    await new Promise((r) => setTimeout(r, 50));
    expect(seen.length).toBe(1);
    expect(seen[0]).toContain("www.google.com");
    expect(seen[0]).toContain("a browser window on your screen");

    state.events.emit("handoff-end", { url: "https://www.google.com/sorry/x", passed: true });
    await new Promise((r) => setTimeout(r, 50));
    expect(cancelled).toBe(true);
    await c.close();
  });

  it("stays silent for clients without the elicitation capability", async () => {
    const state = fakeState();
    const server = buildServer(state);
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st);
    const c = new Client({ name: "test", version: "0" });
    await c.connect(ct);
    // No handler registered: if the server sent elicitation/create anyway, the client would error.
    state.events.emit("handoff", { url: "https://x.test/", where: "a window" });
    await new Promise((r) => setTimeout(r, 50));
    state.events.emit("handoff-end", { url: "https://x.test/", passed: false });
    await c.close();
  });
});
