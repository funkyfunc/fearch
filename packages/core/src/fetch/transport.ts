/**
 * Honest HTTP transport on undici's fetch: self-identifying User-Agent, markdown-first Accept,
 * manual redirects with SSRF re-validation on every hop, byte and time caps, conditional requests,
 * corporate proxy via HTTPS_PROXY/NO_PROXY. No impersonation of any kind.
 */

import { EnvHttpProxyAgent, fetch as undiciFetch, type Dispatcher, type RequestInit as UndiciRequestInit, type Response as UndiciResponse } from "undici";
import type { Audit } from "../audit.js";
import type { Settings } from "../config.js";
import { assertPublicUrl, BlockedURL } from "./guard.js";
import type { ContentKind, Fetched } from "./types.js";

export const ACCEPT_HEADER = "text/markdown, text/x-markdown;q=0.95, text/plain;q=0.9, text/html;q=0.8, application/xhtml+xml;q=0.7, application/pdf;q=0.5, */*;q=0.1";

/** Turn a fetch failure into a sentence a person can act on; TLS-interception failures name the fix. */
export function isTlsError(e: unknown): boolean {
  const c = (e as { cause?: { code?: string; message?: string } })?.cause;
  return /CERT|certificate|self.signed|unable to verify|UNABLE_TO_VERIFY|LEAF_SIGNATURE|UNABLE_TO_GET_ISSUER|SELF_SIGNED|DEPTH_ZERO|ERR_TLS/i.test(`${(e as Error)?.message ?? ""} ${c?.code ?? ""} ${c?.message ?? ""}`);
}

export function describeNetworkError(e: unknown): string {
  const msg = (e as Error)?.message ?? String(e);
  const cause = ((e as { cause?: { code?: string; message?: string } })?.cause?.code ?? (e as { cause?: { message?: string } })?.cause?.message ?? "");
  const all = `${msg} ${cause}`;
  if (/CERT|certificate|self.signed|unable to verify|UNABLE_TO_VERIFY|LEAF_SIGNATURE|UNABLE_TO_GET_ISSUER|SELF_SIGNED|DEPTH_ZERO|ERR_TLS/i.test(all)) {
    return `TLS certificate not trusted (${cause || msg.split("\n")[0]}) — behind a TLS-intercepting proxy, set NODE_EXTRA_CA_CERTS to the proxy's CA bundle`;
  }
  if (/ENOTFOUND|EAI_AGAIN/i.test(all)) return "DNS lookup failed";
  if (/ECONNREFUSED/i.test(all)) return "connection refused";
  if (/ETIMEDOUT|timeout/i.test(all)) return "connection timed out";
  return `network error: ${(cause || msg).split("\n")[0].slice(0, 120)}`;
}

export class FetchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FetchError";
  }
}

export interface GetOptions {
  headers?: Record<string, string>;
  conditional?: { etag?: string | null; lastModified?: string | null };
  maxBytes?: number;
  allowPrivate?: boolean;
  source?: string;
  method?: "GET" | "POST";
  body?: string;
  /** Called before following a redirect to a *different host*; throw to refuse (e.g. robots.txt). */
  beforeCrossHostRedirect?: (nextUrl: string) => Promise<void>;
}

export interface Response extends Fetched {
  notModified: boolean;
  redirects: string[];
}

export function classify(contentType: string, body: Uint8Array, url: string): ContentKind {
  const ct = (contentType || "").split(";")[0].trim().toLowerCase();
  const head = new TextDecoder().decode(body.slice(0, 4000));
  if (ct === "text/markdown" || ct === "text/x-markdown") return "markdown";
  if (ct === "application/pdf" || (!ct && url.toLowerCase().endsWith(".pdf")) || head.startsWith("%PDF-")) return "pdf";
  if (ct === "application/json") return "json";
  if (ct.startsWith("text/plain")) return /^#{1,6} |^```|^\* |^- /m.test(head) ? "markdown" : "text";
  if (ct === "text/html" || ct === "application/xhtml+xml" || /<html|<!doctype/i.test(head.slice(0, 2000))) return "html";
  if (ct.startsWith("text/")) return "text";
  return "html";
}

function proxyDispatcher(): Dispatcher | undefined {
  const env = process.env;
  if (env.HTTPS_PROXY || env.https_proxy || env.HTTP_PROXY || env.http_proxy) return new EnvHttpProxyAgent();
  return undefined;
}

export class Transport {
  private readonly dispatcher = proxyDispatcher();

  constructor(
    private readonly settings: Settings,
    private readonly audit: Audit,
  ) {}

  async get(url: string, opts: GetOptions = {}): Promise<Response> {
    const started = Date.now();
    const maxBytes = opts.maxBytes ?? this.settings.maxBytes;
    const headers: Record<string, string> = {
      "user-agent": this.settings.userAgent,
      accept: ACCEPT_HEADER,
      "accept-language": "en-US,en;q=0.8",
      ...Object.fromEntries(Object.entries(opts.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v])),
    };
    if (opts.conditional?.etag) headers["if-none-match"] = opts.conditional.etag;
    if (opts.conditional?.lastModified) headers["if-modified-since"] = opts.conditional.lastModified;

    let current = url;
    let httpRetried = false;
    const redirects: string[] = [];
    for (let hop = 0; ; hop++) {
      let res: UndiciResponse;
      try {
        const init: UndiciRequestInit = {
          method: opts.method ?? "GET",
          body: opts.body,
          headers,
          redirect: "manual",
          signal: AbortSignal.timeout(this.settings.timeoutMs),
          dispatcher: this.dispatcher,
        };
        res = await undiciFetch(current, init);
      } catch (e) {
        const msg = (e as Error).name === "TimeoutError" ? `timed out after ${this.settings.timeoutMs / 1000}s` : describeNetworkError(e);
        // We upgrade http→https optimistically; if https cannot connect at all, try plain http once.
        // Never on a certificate error: the host does speak TLS, and silently downgrading to http
        // would hide a TLS-interception problem (and send the request in the clear).
        if (current.startsWith("https://") && hop === 0 && !httpRetried && (e as Error).name !== "TimeoutError" && !isTlsError(e)) {
          httpRetried = true;
          this.audit.record({ url: current, status: "error", note: `${msg}; retrying over http`, provider: opts.source });
          current = "http://" + current.slice("https://".length);
          hop--;
          continue;
        }
        this.audit.record({ url: current, status: "error", note: msg, ms: Date.now() - started, provider: opts.source });
        throw new FetchError(`Connection failed for ${current}: ${msg}`);
      }

      if ([301, 302, 303, 307, 308].includes(res.status)) {
        const loc = res.headers.get("location");
        await res.body?.cancel().catch(() => {});
        if (!loc) throw new FetchError(`Redirect from ${current} without a Location header.`);
        if (hop >= this.settings.maxRedirects) throw new FetchError(`Too many redirects (>${this.settings.maxRedirects}) from ${url}.`);
        let next: string;
        try {
          // The server chose the redirect scheme; don't re-upgrade it (an http target after an https
          // page is the server's decision, and upgrading would break plain-http hosts).
          next = await assertPublicUrl(new URL(loc, current).toString(), { allowPrivate: opts.allowPrivate ?? this.settings.allowPrivate, keepScheme: true });
        } catch (e) {
          if (e instanceof BlockedURL) throw new FetchError(`Redirect target refused: ${e.message}`);
          throw e;
        }
        this.audit.record({ url: current, status: res.status, note: `redirect → ${next}`, provider: opts.source });
        if (opts.beforeCrossHostRedirect && new URL(next).host !== new URL(current).host) {
          await opts.beforeCrossHostRedirect(next);
        }
        redirects.push(next);
        current = next;
        continue;
      }

      const hdrs: Record<string, string> = {};
      res.headers.forEach((v, k) => (hdrs[k] = v));
      const contentType = hdrs["content-type"] ?? "";

      if (res.status === 304) {
        await res.body?.cancel().catch(() => {});
        this.audit.record({ url: current, status: 304, cache: "revalidated", ms: Date.now() - started, provider: opts.source });
        return { url, finalUrl: current, kind: "text", body: "", source: opts.source ?? "direct", status: 304, contentType, headers: hdrs, notModified: true, redirects };
      }

      const declared = Number(hdrs["content-length"]);
      if (Number.isFinite(declared) && declared > maxBytes) {
        await res.body?.cancel().catch(() => {});
        throw new FetchError(`Response too large (${Math.round(declared / 1024 / 1024)} MB > ${Math.round(maxBytes / 1024 / 1024)} MB cap).`);
      }
      const body = await readCapped(res, maxBytes);
      this.audit.record({ url: current, status: res.status, bytes: body.length, ms: Date.now() - started, provider: opts.source });
      return {
        url,
        finalUrl: current,
        kind: classify(contentType, body, current),
        body,
        source: opts.source ?? "direct",
        status: res.status,
        contentType,
        headers: hdrs,
        notModified: false,
        redirects,
      };
    }
  }
}

async function readCapped(res: UndiciResponse, maxBytes: number): Promise<Uint8Array> {
  if (!res.body) return new Uint8Array();
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new FetchError(`Response exceeded the ${Math.round(maxBytes / 1024 / 1024)} MB cap while downloading.`);
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}
