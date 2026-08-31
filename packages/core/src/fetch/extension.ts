/**
 * The extension tier: pages are opened in the person's own Chrome by the "fearch bridge" extension
 * (packages/core/extension). No automation flags, no DevTools/CDP, nothing fabricated — it is the
 * person's browser doing what browsers do, on their behalf. The extension knows three verbs (open a
 * URL in a background tab, read it, close it) plus "activate" for the human handoff.
 *
 * Transport: the server listens on 127.0.0.1 on a small fixed port range; the extension long-polls
 * `/fearch/next` for jobs and posts `/fearch/result`. Both sides are paired through a shared secret
 * written by `fearch extension install` (into `<cacheDir>/extension-token` for the server and
 * `token.json` in the extension folder). The token never crosses the wire: the extension proves it
 * holds it with a SHA-256 over a fresh nonce on every poll, and the server proves it back on every
 * job before the extension will execute anything. Without that, any local process could bind the
 * well-known port first and drive the person's logged-in Chrome — the pairing closes exactly that.
 * The Origin check (the extension ID is fixed by the `key` in its manifest) additionally stops web
 * pages from talking to the bridge at all.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Audit } from "../audit.js";
import type { Settings } from "../config.js";
import { BrowserUnavailable, waitForHuman, type BrowserTier, type Rendered, type RenderOptions } from "./browser.js";
import { isChallengePage } from "./diagnose.js";
import { BlockedURL, isBlockedHostname, isPrivateAddress, normalizeUrl } from "./guard.js";
import { isIP } from "node:net";

export const EXTENSION_ID = "gabikoejpalecfplpddejellljanhjeo";
export const EXTENSION_PORTS = [47365, 47366, 47367, 47368, 47369];
const POLL_HOLD_MS = 25_000;
const CONNECTED_WINDOW_MS = 40_000;

export function extensionTokenPath(cacheDir: string): string {
  return join(cacheDir, "extension-token");
}

/** The pairing secret shared with the extension. Created on first use, private to this user. */
export function loadOrCreateExtensionToken(cacheDir: string): string {
  const path = extensionTokenPath(cacheDir);
  try {
    const t = readFileSync(path, "utf8").trim();
    if (t) return t;
  } catch {
    // fall through to create
  }
  const token = randomBytes(32).toString("hex");
  mkdirSync(cacheDir, { recursive: true });
  writeFileSync(path, token + "\n", { mode: 0o600 });
  return token;
}

interface Job {
  id: string;
  op: "ping" | "open" | "read" | "activate" | "close";
  url?: string;
  tabId?: number;
  incognito?: boolean;
  settleSelector?: string;
  settleMs?: number;
  timeoutMs?: number;
}
interface JobResult {
  id: string;
  ok: boolean;
  error?: string;
  tabId?: number;
  html?: string;
  url?: string;
  title?: string;
  version?: string;
  incognitoAllowed?: boolean;
}
export interface ExtensionInfo {
  version: string;
  incognitoAllowed: boolean;
}

function readJson(req: IncomingMessage, limit = 16 * 1024 * 1024): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > limit) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

export class ExtensionBridge {
  private server: Server | null = null;
  private port = 0;
  private queue: Job[] = [];
  private waiters: Array<(job: Job | null) => void> = [];
  private pending = new Map<string, { resolve: (r: JobResult) => void; timer: NodeJS.Timeout }>();
  private lastPoll = 0;
  private lastUnpairedPoll = 0;
  private info: ExtensionInfo | null = null;
  private starting: Promise<number> | null = null;

  constructor(
    private readonly audit: Audit,
    private readonly token: string,
    private readonly extensionId = process.env.FEARCH_EXTENSION_ID || EXTENSION_ID,
    private readonly ports = EXTENSION_PORTS,
  ) {}

  /** Both sides derive proofs from the shared token; the token itself never crosses the wire. */
  private proof(kind: "poll" | "job" | "result", ...parts: string[]): string {
    return createHash("sha256")
      .update(`${this.token}:${kind}:${parts.join(":")}`)
      .digest("hex");
  }

  get listeningPort(): number {
    return this.port;
  }

  /** True when the extension has polled recently (it polls continuously while Chrome is open). */
  connected(): boolean {
    return Date.now() - this.lastPoll < CONNECTED_WINDOW_MS;
  }

  extensionInfo(): ExtensionInfo | null {
    return this.info;
  }

  /** Bind the first free port in the range. Idempotent. */
  async start(): Promise<number> {
    if (this.server) return this.port;
    if (this.starting) return this.starting;
    this.starting = (async () => {
      for (const port of this.ports) {
        const ok = await new Promise<boolean>((resolve) => {
          const srv = createServer((req, res) => void this.route(req, res));
          srv.once("error", () => resolve(false));
          srv.listen(port, "127.0.0.1", () => {
            this.server = srv;
            this.port = port;
            resolve(true);
          });
        });
        if (ok) {
          this.audit.log(
            "info",
            `extension bridge listening on 127.0.0.1:${this.port} (waiting for the fearch bridge extension in your Chrome)`,
          );
          return this.port;
        }
      }
      throw new BrowserUnavailable(
        `extension bridge: ports ${this.ports[0]}-${this.ports[this.ports.length - 1]} are all in use`,
      );
    })();
    try {
      return await this.starting;
    } finally {
      this.starting = null;
    }
  }

  private fromExtension(req: IncomingMessage): boolean {
    return req.headers.origin === `chrome-extension://${this.extensionId}`;
  }

  private async route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const json = (code: number, body: unknown) => {
      res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify(body));
    };
    try {
      if (url.pathname === "/fearch/status" && req.method === "GET") {
        return json(200, {
          connected: this.connected(),
          extension: this.info,
          port: this.port,
          extensionId: this.extensionId,
          // An extension is polling but failing the pairing check — almost always a stale token.json.
          unpairedExtensionSeen: Date.now() - this.lastUnpairedPoll < CONNECTED_WINDOW_MS,
        });
      }
      if (url.pathname === "/setup" && req.method === "GET") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(setupPage(this.extensionId));
        return;
      }
      if (!url.pathname.startsWith("/fearch/")) return json(404, { error: "not found" });
      if (req.method !== "POST") return json(405, { error: "POST only" });
      if (!this.fromExtension(req))
        return json(403, { error: "requests are accepted only from the fearch bridge extension" });
      const body = (await readJson(req)) as Record<string, unknown>;
      if (url.pathname === "/fearch/next") {
        const nonce = typeof body.nonce === "string" ? body.nonce : "";
        if (!nonce || body.auth !== this.proof("poll", nonce)) {
          this.lastUnpairedPoll = Date.now();
          return json(403, {
            error:
              "not paired with this fearch server — run `fearch extension install` to write the pairing token, then reload the extension at chrome://extensions",
          });
        }
        this.lastPoll = Date.now();
        if (typeof body.version === "string")
          this.info = { version: body.version, incognitoAllowed: !!body.incognitoAllowed };
        const job = await this.nextJob();
        if (!job) {
          res.writeHead(204, { "cache-control": "no-store" });
          res.end();
          return;
        }
        // The proof lets the extension verify this server holds the token before executing the job.
        return json(200, { ...job, proof: this.proof("job", nonce, job.id) });
      }
      if (url.pathname === "/fearch/result") {
        const r = body as unknown as JobResult & { auth?: string };
        if (typeof r.id !== "string" || r.auth !== this.proof("result", r.id))
          return json(403, { error: "not paired" });
        const p = this.pending.get(r.id);
        if (p) {
          clearTimeout(p.timer);
          this.pending.delete(r.id);
          p.resolve(r);
        }
        return json(200, { ok: true });
      }
      return json(404, { error: "not found" });
    } catch (e) {
      return json(400, { error: (e as Error).message });
    }
  }

  private nextJob(): Promise<Job | null> {
    const job = this.queue.shift();
    if (job) return Promise.resolve(job);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w !== waiter);
        resolve(null);
      }, POLL_HOLD_MS);
      const waiter = (j: Job | null) => {
        clearTimeout(timer);
        resolve(j);
      };
      this.waiters.push(waiter);
    });
  }

  /** Queue a job for the extension and wait for its result. */
  request(job: Omit<Job, "id">, timeoutMs = 30_000): Promise<JobResult> {
    const full: Job = { ...job, id: randomUUID() };
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(full.id);
        this.queue = this.queue.filter((j) => j.id !== full.id);
        resolve({ id: full.id, ok: false, error: `extension did not answer within ${Math.round(timeoutMs / 1000)} s` });
      }, timeoutMs);
      this.pending.set(full.id, { resolve, timer });
      const waiter = this.waiters.shift();
      if (waiter) waiter(full);
      else this.queue.push(full);
    });
  }

  /** Wait (bounded) for the extension to show up. */
  async waitForConnection(ms: number): Promise<boolean> {
    await this.start();
    const deadline = Date.now() + ms;
    while (!this.connected() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 250));
    return this.connected();
  }

  async close(): Promise<void> {
    for (const w of this.waiters) w(null);
    this.waiters = [];
    for (const [, p] of this.pending) clearTimeout(p.timer);
    this.pending.clear();
    const srv = this.server;
    this.server = null;
    if (srv) {
      // The extension's long-poll and keep-alive connections would otherwise hold close() open for up to 25 s.
      await new Promise<void>((r) => {
        srv.close(() => r());
        srv.closeAllConnections();
      });
    }
  }
}

/** The renderer used when `--browser extension`: the person's Chrome via the bridge; falls back to a given tier if the extension isn't there. */
export class ExtensionRenderer implements BrowserTier {
  readonly headed = true;
  readonly browserChannel = "extension";
  private warnedFallback = false;

  constructor(
    private readonly settings: Settings,
    private readonly audit: Audit,
    readonly bridge: ExtensionBridge,
    private readonly fallback?: BrowserTier,
  ) {}

  enabled(): boolean {
    return true;
  }

  get browserUserAgent(): string {
    return "your Chrome (fearch bridge extension)";
  }

  async render(url: string, opts: RenderOptions = {}): Promise<Rendered> {
    // The pipeline has already normalised (and upgraded) the URL; keep its scheme — a page that only
    // speaks http would otherwise land on an SSL error page in the tab.
    const target = normalizeUrl(url, { keepScheme: true });
    const host = new URL(target).hostname.replace(/^\[|\]$/g, "");
    if (!this.settings.allowPrivate && (isBlockedHostname(host) || (isIP(host) && isPrivateAddress(host)))) {
      throw new BlockedURL(`refusing to open a private address in the browser (${target})`);
    }
    if (!(await this.bridge.waitForConnection(this.settings.extensionConnectMs))) {
      const hint =
        "the fearch bridge extension is not connected — run `fearch extension install` (or open chrome://extensions and check it is enabled)";
      if (this.fallback) {
        if (!this.warnedFallback) {
          this.audit.log(
            "warn",
            `${hint}; using the ${this.fallback.headed ? "headed" : "headless"} browser tier instead${
              this.fallback.headed ? "" : " — challenges cannot be handed to you until the extension connects"
            }`,
          );
          this.warnedFallback = true;
        }
        return this.fallback.render(url, opts);
      }
      throw new BrowserUnavailable(hint);
    }
    this.warnedFallback = false;
    const started = Date.now();
    const opened = await this.bridge.request(
      {
        op: "open",
        url: target,
        incognito: this.settings.incognito,
        settleSelector: opts.settleSelector,
        timeoutMs: this.settings.browserTimeoutMs,
      },
      this.settings.browserTimeoutMs + 15_000,
    );
    if (!opened.ok || opened.tabId === undefined)
      throw new BrowserUnavailable(`extension: ${opened.error ?? "could not open the page"}`);
    const tabId = opened.tabId;
    let html = opened.html ?? "";
    let finalUrl = opened.url ?? target;
    let handedOff = false;
    try {
      if (opts.settleUntil) {
        const deadline = Date.now() + (opts.settleUntilMs ?? 2500);
        while (!opts.settleUntil(html) && Date.now() < deadline) {
          await new Promise((res) => setTimeout(res, 400));
          const again = await this.bridge.request({ op: "read", tabId }, 10_000);
          if (again.ok && again.html) {
            html = again.html;
            finalUrl = again.url ?? finalUrl;
          }
        }
      }
      const isChallenge = opts.isChallenge ?? isChallengePage;
      if (this.settings.handoff && opts.handoff !== false && isChallenge(html, 200, finalUrl)) {
        this.audit.log(
          "warn",
          `challenge on ${target}: handed to you in your Chrome (waiting up to ${Math.round(this.settings.handoffTimeoutMs / 1000)} s)`,
        );
        await this.bridge.request({ op: "activate", tabId });
        const r = await waitForHuman(
          async () => {
            const s = await this.bridge.request({ op: "read", tabId }, 10_000);
            return { html: s.ok ? (s.html ?? "") : "", status: 200, url: s.url ?? finalUrl };
          },
          (h, s, u) => !h || isChallenge(h, s, u),
          this.settings.handoffTimeoutMs,
        );
        if (r.passed) {
          html = r.html;
          finalUrl = r.url;
          handedOff = true;
          this.audit.log("info", `challenge on ${target} passed by you; continuing`);
        } else this.audit.log("warn", `challenge on ${target} not passed within the handoff window`);
      }
      const finalHost = new URL(finalUrl).hostname.replace(/^\[|\]$/g, "");
      if (
        !this.settings.allowPrivate &&
        (isBlockedHostname(finalHost) || (isIP(finalHost) && isPrivateAddress(finalHost)))
      ) {
        throw new BlockedURL(`browser navigation ended at a private address (${finalUrl})`);
      }
      this.audit.record({
        url: target,
        status: 200,
        bytes: html.length,
        provider: this.settings.incognito ? "extension (incognito)" : "extension",
        ms: Date.now() - started,
        note: handedOff ? "challenge handed to the person" : undefined,
      });
      return {
        html,
        finalUrl,
        status: 200,
        salvaged: false,
        // A non-incognito tab is the person's own profile — their logins ride along, so say so.
        usedSession: !this.settings.incognito,
        handedOff,
        label: this.settings.incognito ? "your Chrome, incognito" : "your Chrome",
      };
    } finally {
      // Awaited (bounded) so a tab never outlives the request that opened it.
      await this.bridge.request({ op: "close", tabId }, 5_000);
    }
  }

  async close(): Promise<void> {
    await this.fallback?.close();
    await this.bridge.close();
  }
}

function setupPage(extensionId: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>fearch bridge setup</title>
<style>body{font:15px/1.6 system-ui,sans-serif;max-width:640px;margin:40px auto;color:#222}code{background:#f1f3f4;padding:2px 5px;border-radius:3px}.ok{color:#137333}.no{color:#a50e0e}ol li{margin:6px 0}</style></head>
<body><h1>fearch bridge</h1><p id="s" class="no">✘ not connected yet</p>
<ol><li>Open <code>chrome://extensions</code> (Chrome won't let this page link there).</li>
<li>Turn on <b>Developer mode</b> (top right).</li>
<li>Click <b>Load unpacked</b> and choose the folder <code>fearch extension install</code> printed (it is on your clipboard).</li>
<li>Optional: open the extension's details and enable <b>Allow in Incognito</b> for <code>FEARCH_INCOGNITO=1</code>.</li></ol>
<p>Expected extension ID: <code>${extensionId}</code></p>
<script>setInterval(()=>fetch('/fearch/status').then(r=>r.json()).then(s=>{const e=document.getElementById('s');if(s.connected){e.className='ok';e.textContent='✔ connected (extension '+(s.extension&&s.extension.version)+')'}else if(s.unpairedExtensionSeen){e.textContent='✘ extension found but not paired — run \`fearch extension install\` again, then reload the extension'}}),1500)</script>
</body></html>`;
}
