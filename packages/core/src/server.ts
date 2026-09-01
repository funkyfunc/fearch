/** The MCP server: two tools, `search` and `fetch`, over the app. stdio framing lives in cli.ts. */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ElicitResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { App } from "./app.js";
import { personPresent, type Settings } from "./config.js";
import { describeError } from "./errors.js";
import { READ_MODES, readDocument, type ReadOptions } from "./fetch/read.js";
import { attachExcerpts } from "./search/excerpt.js";
import { renderResults } from "./search/render.js";

/**
 * Tool descriptions are built from the effective settings so the model is never told something the
 * configuration makes untrue (e.g. "robots.txt is honoured" under --robots off).
 */
export function searchDescription(s: Settings): string {
  const posture = personPresent(s)
    ? `Engine result pages${s.engines.length ? ` (${s.engines.join(", ")})` : ""} are the person's own browsing — queried on their behalf at human pace, with any challenge opened in a visible window for them to pass; the tool never solves anything.`
    : s.robotsPolicy === "off"
      ? `robots.txt is not consulted on this server (operator's choice — user-agent posture); the tool still identifies itself honestly, paces requests, and never solves challenges.`
      : `This server searches only where automated clients are permitted (DuckDuckGo lite in a real, self-identified browser).`;
  return `Search the web. Returns a ranked markdown list of results (title, URL, snippet) and names the provider the query went to.

Use this for discovery — docs pages, GitHub repos/issues, blog posts, error messages, package names. Then call \`fetch\` on the best URL. To save a round trip, pass \`fetch_top=N\` (1–3): the top N results are fetched and the passages most relevant to your query are included inline.

\`site="docs.python.org"\` restricts to a domain; \`recency="w"\` limits to the past week (d/w/m/y). Prefer these parameters over typing \`site:\`/\`before:\` operators — they are translated to each engine's own mechanism (not every engine supports every operator). Quoted phrases and \`-term\` exclusions work as typed. Results carry a date when the engine shows one. Quote exact error strings. If results are poor, rephrase rather than paging.

${posture} It never impersonates a browser or hides that it is automated.`;
}

export function fetchDescription(s: Settings): string {
  const robots =
    s.robotsPolicy === "off"
      ? "robots.txt is not consulted on this server (operator's choice — user-agent posture), but it still identifies itself honestly and waits between requests to a host"
      : "identifies itself honestly, honours robots.txt (including AI-agent opt-outs), and waits between requests to a host";
  return `Fetch a web page and return its main content as clean markdown (boilerplate removed; code blocks and tables preserved). Handles HTML, markdown, plain text, PDF, GitHub (files, READMEs, issues, tree listings, releases, gists), PyPI, npm, StackOverflow and llms.txt.

Output is bounded by \`max_chars\` (default 12000). Long pages: don't page blindly — pick a mode:
  - \`mode="focus", query="what you are looking for"\` → only the sections relevant to that phrase (BM25, no LLM).
  - \`mode="section", query="Heading text"\` → exactly that section and its subsections (fuzzy match; the error lists available headings).
  - \`mode="pattern", query="regex"\` → only matches with context and positions ("does this page mention X?").
  - \`mode="read"\` (default) with \`cursor\` copied from the footer to continue where you left off.
The header says when the page was last updated when the site declares it; "may be stale" means over a year old.
\`urls=[...]\` (max 5) reads several pages in one call. \`include_links=true\` keeps hyperlinks as reference-style links.

Respectful by design: ${robots}. If the plain HTTP client gets an empty JavaScript shell or is refused, the page is opened once in a real, self-identified browser (no stealth, no CAPTCHA solving). If that is refused too (403, CAPTCHA, paywall, login) the refusal is final — you get a Diagnosis explaining why and what to do instead; do not retry the same URL. \`archive=true\` reads a Wayback Machine copy, only for pages that are gone (404/410).`;
}

const READ_ONLY = { readOnlyHint: true, openWorldHint: true, idempotentHint: true, destructiveHint: false } as const;
const MAX_URLS_PER_CALL = 5;

const SEARCH_INPUT = {
  query: z.string().min(2).describe("Search query. Supports quoted phrases."),
  max_results: z.number().int().min(1).max(20).default(8).describe("Number of results (default 8)."),
  recency: z.enum(["d", "w", "m", "y"]).optional().describe("Restrict to the past day/week/month/year."),
  site: z.string().optional().describe("Restrict results to this domain, e.g. 'docs.python.org'."),
  allowed_domains: z.array(z.string()).optional().describe("Only include results from these domains."),
  blocked_domains: z.array(z.string()).optional().describe("Never include results from these domains."),
  fetch_top: z
    .number()
    .int()
    .min(0)
    .max(3)
    .default(0)
    .describe("Also fetch the top N results and include query-focused excerpts inline."),
};

const FETCH_INPUT = {
  url: z.string().optional().describe("URL to fetch."),
  urls: z
    .array(z.string())
    .max(MAX_URLS_PER_CALL)
    .optional()
    .describe(`Up to ${MAX_URLS_PER_CALL} URLs to fetch in one call (same mode/query for all).`),
  mode: z
    .enum(READ_MODES as [string, ...string[]])
    .default("read")
    .describe(
      "read: the page from the start. focus: only sections relevant to `query`. section: the heading named by `query`. pattern: regex matches with context. raw: the page's raw HTML/text (the rendered DOM when a browser was needed).",
    ),
  query: z.string().optional().describe("For focus (a phrase), section (a heading), or pattern (a regex)."),
  max_chars: z.number().int().min(500).max(100_000).optional().describe("Character budget (default 12000)."),
  cursor: z.string().optional().describe("Continuation token copied from a previous footer."),
  include_links: z.boolean().default(false).describe("Keep hyperlinks as reference-style links with a footer."),
  context_chars: z.number().int().min(20).max(2000).default(200).describe("pattern mode: context around each match."),
  archive: z
    .boolean()
    .default(false)
    .describe(
      "Read a Wayback Machine copy — only for pages that are gone (404/410); never a bypass for blocked pages.",
    ),
};

type ToolResult = { content: [{ type: "text"; text: string }]; isError?: true };
const text = (t: string): ToolResult => ({ content: [{ type: "text", text: t }] });
const failure = (t: string): ToolResult => ({ content: [{ type: "text", text: t }], isError: true });

/**
 * When a challenge is handed to the person (a window opens, a Chrome tab activates), tell them
 * through their MCP client too — a form-mode elicitation used purely as a notification. The handoff
 * itself never depends on the answer (the page is polled for the check clearing); the prompt is
 * aborted the moment the handoff resolves so it cannot go stale. URL-mode elicitation is deliberately
 * NOT used: it would navigate the person to a fresh copy of the page in their default browser, whose
 * cookie jar is not the one the render is waiting on. Clients without elicitation lose nothing.
 */
function wireHandoffElicitation(app: App, server: McpServer): void {
  const pending = new Map<string, AbortController>();
  // Burn outgoing request id 0 on a ping: the SDK's cancellation handler treats `requestId: 0` as
  // missing (a falsy check), so a cancellation for the server's first request is silently dropped —
  // and the first handoff elicitation would otherwise be exactly that request.
  server.server.oninitialized = () => {
    void server.server.ping().catch(() => {});
  };
  app.events.on("handoff", ({ url, where }) => {
    if (!server.server.getClientCapabilities()?.elicitation) return;
    let host = url;
    try {
      host = new URL(url).host;
    } catch {
      // keep the raw url
    }
    const ac = new AbortController();
    pending.get(url)?.abort();
    pending.set(url, ac);
    // Raw request rather than elicitInput(): clients predating the form/url split declare the
    // legacy empty `elicitation: {}` capability (spec: equivalent to form-only), which the SDK's
    // helper would reject.
    void server.server
      .request(
        {
          method: "elicitation/create",
          params: {
            message: `A bot-check appeared while opening ${host}. It is waiting in ${where} — complete it there and this request continues by itself (this prompt dismisses on its own).`,
            requestedSchema: { type: "object", properties: {} },
          },
        },
        ElicitResultSchema,
        { signal: ac.signal },
      )
      .catch(() => {
        // declined, unsupported, or aborted — the notification already did its job
      })
      .finally(() => {
        if (pending.get(url) === ac) pending.delete(url);
      });
  });
  app.events.on("handoff-end", ({ url }) => pending.get(url)?.abort());
}

/** MCP progress notifications, when the client asked for them (`_meta.progressToken`). Never throws. */
type ToolExtra = { _meta?: { progressToken?: string | number }; sendNotification?: (n: never) => Promise<void> };
function progressReporter(extra: ToolExtra, total: number): (progress: number, message: string) => Promise<void> {
  const token = extra._meta?.progressToken;
  const send = extra.sendNotification;
  if (token === undefined || !send) return async () => {};
  return async (progress, message) => {
    try {
      await send({
        method: "notifications/progress",
        params: { progressToken: token, progress, total, message },
      } as never);
    } catch {
      // progress is best-effort
    }
  };
}

export function buildServer(app: App): McpServer {
  const server = new McpServer({ name: "fearch", version: app.settings.version });
  wireHandoffElicitation(app, server);

  server.registerTool(
    "search",
    {
      title: "Web search",
      description: searchDescription(app.settings),
      inputSchema: SEARCH_INPUT,
      annotations: READ_ONLY,
    },
    async (args, extra) => {
      const query = args.query.trim();
      const progress = progressReporter(extra, 1 + args.fetch_top);
      try {
        const outcome = await app.search.search({
          query,
          maxResults: args.max_results,
          recency: args.recency,
          site: args.site?.trim() || undefined,
          allowedDomains: args.allowed_domains,
          blockedDomains: args.blocked_domains,
        });
        await progress(1, `search done via ${outcome.providers.map((p) => p.name).join("+") || "cache"}`);
        await attachExcerpts(app, outcome.results, query, args.fetch_top, (done, r) =>
          progress(1 + done, `excerpt ${done}/${args.fetch_top}: ${r.url}`),
        );
        return text(renderResults(query, outcome));
      } catch (e) {
        return failure(describeError(`search:${query}`, e));
      }
    },
  );

  server.registerTool(
    "fetch",
    {
      title: "Fetch page",
      description: fetchDescription(app.settings),
      inputSchema: FETCH_INPUT,
      annotations: READ_ONLY,
    },
    async (args, extra) => {
      const targets = [...(args.url ? [args.url] : []), ...(args.urls ?? [])].map((u) => u.trim()).filter(Boolean);
      if (!targets.length) return failure("Provide `url` or `urls`.");
      if (targets.length > MAX_URLS_PER_CALL) return failure(`At most ${MAX_URLS_PER_CALL} URLs per call.`);

      // Several pages share the budget unless the caller set one explicitly.
      const maxChars =
        args.max_chars ??
        (targets.length > 1
          ? Math.max(2000, Math.floor(app.settings.maxChars / targets.length))
          : app.settings.maxChars);
      const options: ReadOptions = {
        mode: args.mode as ReadOptions["mode"],
        query: args.query?.trim() || undefined,
        maxChars,
        cursor: args.cursor,
        includeLinks: args.include_links,
        contextChars: args.context_chars,
      };
      const readOne = async (url: string) => {
        const doc = await app.fetcher.fetch(url, {
          raw: options.mode === "raw",
          via: args.archive ? "archive" : undefined,
        });
        return readDocument(doc, options);
      };
      const progress = progressReporter(extra, targets.length);

      if (targets.length === 1) {
        try {
          const out = await readOne(targets[0]);
          await progress(1, `fetched ${targets[0]}`);
          return text(out);
        } catch (e) {
          return failure(describeError(targets[0], e));
        }
      }
      let done = 0;
      const outcomes = await Promise.allSettled(
        targets.map(async (t) => {
          try {
            return await readOne(t);
          } finally {
            await progress(++done, `${done}/${targets.length}: ${t}`);
          }
        }),
      );
      const parts = outcomes.map((r, i) =>
        r.status === "fulfilled" ? r.value : `# (failed) ${targets[i]}\n${describeError(targets[i], r.reason)}\n`,
      );
      return text(parts.join("\n\n=====\n\n"));
    },
  );

  return server;
}
