/**
 * Exa's publicly offered keyless MCP endpoint (https://mcp.exa.ai/mcp) — "free plan covers casual
 * use". A vendor's own product, so this is an official channel (docs/SPECTRUM.md rung 0), used as
 * the default general-web provider. Queries are sent to Exa; that is disclosed in every result.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { EnvHttpProxyAgent, fetch as undiciFetch, type Dispatcher } from "undici";
import type { Settings } from "../config.js";
import {
  dedupe,
  filterDomains,
  isoDate,
  SearchError,
  type SearchProvider,
  type SearchResponse,
  type SearchQuery,
  type SearchResult,
} from "./provider.js";

interface ExaItem {
  title?: string;
  url?: string;
  text?: string;
  highlights?: string[];
  snippet?: string;
  publishedDate?: string;
}

export function parseExaToolText(text: string, provider: string): SearchResult[] {
  const trimmed = text.trim();
  // JSON shape: {results: [...]} or [...]
  try {
    const data = JSON.parse(trimmed) as { results?: ExaItem[] } | ExaItem[];
    const items = Array.isArray(data) ? data : (data.results ?? []);
    return items
      .filter((i) => i.url)
      .map((i) => ({
        title: (i.title ?? "").trim(),
        url: String(i.url),
        snippet: (i.highlights?.join(" ") ?? i.snippet ?? i.text ?? "")
          .replace(/¶/g, "")
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, 500),
        provider,
        date: isoDate(i.publishedDate),
      }));
  } catch {
    // Markdown/text shape: blocks with "Title:" / "URL:" lines
  }
  const out: SearchResult[] = [];
  const blocks = trimmed.split(/\n\s*\n/);
  for (const b of blocks) {
    const url = /(?:^|\n)\s*(?:URL|Link)\s*:\s*(\S+)/i.exec(b)?.[1] ?? /https?:\/\/\S+/.exec(b)?.[0];
    if (!url) continue;
    const title =
      /(?:^|\n)\s*(?:Title)\s*:\s*(.+)/i.exec(b)?.[1]?.trim() ??
      b
        .split("\n")[0]
        .replace(/^[#*\s-]+/, "")
        .trim();
    const date = isoDate(/(?:^|\n)\s*(?:Published|Date)\s*(?:Date)?\s*:\s*(\S+)/i.exec(b)?.[1]);
    const snippet = b
      .split("\n")
      .filter((l) => !/^\s*(Title|URL|Link|Published|Author|Score)\s*:/i.test(l) && !l.includes(url))
      .join(" ")
      .replace(/^\s*(Highlights?|Summary|Text)\s*:\s*/i, "")
      .replace(/¶/g, "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 500);
    out.push({ title, url, snippet, provider, date });
  }
  return out;
}

export class ExaHostedProvider implements SearchProvider {
  name = "exa-hosted";
  disclosure = "queries sent to Exa's public MCP endpoint (keyless, casual-use tier)";
  kinds: SearchProvider["kinds"] = ["web"];
  posture: SearchProvider["posture"] = "official";
  private client: Client | null = null;
  private connecting: Promise<Client> | null = null;
  private readonly dispatcher: Dispatcher | undefined;

  constructor(private readonly settings: Settings) {
    const env = process.env;
    this.dispatcher =
      env.HTTPS_PROXY || env.https_proxy || env.HTTP_PROXY || env.http_proxy ? new EnvHttpProxyAgent() : undefined;
  }

  available(): boolean {
    return !!this.settings.exaHostedUrl;
  }

  private async connect(): Promise<Client> {
    if (this.client) return this.client;
    if (this.connecting) return this.connecting;
    this.connecting = (async () => {
      const client = new Client({ name: "fearch", version: this.settings.version }, { capabilities: {} });
      const headers = { "user-agent": this.settings.userAgent };
      const dispatcher = this.dispatcher;
      const transport = new StreamableHTTPClientTransport(new URL(this.settings.exaHostedUrl), {
        requestInit: { headers },
        fetch: (url, init) =>
          undiciFetch(
            url as string,
            { ...(init as object), dispatcher } as never,
          ) as unknown as Promise<globalThis.Response>,
      });
      await client.connect(transport);
      this.client = client;
      return client;
    })();
    try {
      return await this.connecting;
    } finally {
      this.connecting = null;
    }
  }

  async search(q: SearchQuery): Promise<SearchResponse> {
    let client: Client;
    try {
      client = await this.connect();
    } catch (e) {
      throw new SearchError(`exa-hosted: could not connect (${(e as Error).message})`);
    }
    const query = q.site ? `${q.query} site:${q.site}` : q.query;
    let res: Awaited<ReturnType<Client["callTool"]>>;
    try {
      res = await client.callTool({
        name: "web_search_exa",
        arguments: { query, numResults: Math.min(q.maxResults * 2, 20) },
      });
    } catch (e) {
      const msg = (e as Error).message;
      this.client = null; // reconnect next time
      if (/429|rate/i.test(msg))
        throw new SearchError("exa-hosted: rate-limited (keyless casual-use tier); waiting a few minutes lifts it.");
      throw new SearchError(`exa-hosted: ${msg}`);
    }
    if (res.isError) {
      const msg = (res.content as Array<{ type: string; text?: string }>).map((c) => c.text ?? "").join(" ");
      if (/rate limit/i.test(msg))
        throw new SearchError("exa-hosted: rate-limited (keyless casual-use tier); waiting a few minutes lifts it.");
      throw new SearchError(`exa-hosted: ${msg.slice(0, 300)}`);
    }
    const text = (res.content as Array<{ type: string; text?: string }>)
      .filter((c) => c.type === "text" && c.text)
      .map((c) => c.text!)
      .join("\n\n");
    const results = filterDomains(dedupe(parseExaToolText(text, this.name)), q);
    if (!results.length) throw new SearchError("exa-hosted: no results");
    return { results: results.slice(0, q.maxResults) };
  }

  async close(): Promise<void> {
    await this.client?.close().catch(() => {});
    this.client = null;
  }
}
