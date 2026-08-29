/**
 * Browser tier: a real Chromium (Playwright) used when the plain HTTP client either got an empty JS
 * shell or was refused, and for search-engine result pages. Two modes:
 *
 * - `headless` (default): the bundled Chromium in new-headless mode. No cookies survive the process.
 * - `headed`: the Chrome already installed on the machine (bundled Chromium if none), in a visible
 *   window. The person can see every tab the tool opens, and with `FEARCH_HANDOFF=1` is handed a
 *   challenge page to deal with themselves — the tool waits, then continues with what they were
 *   shown. A tool-owned profile (cookies/storage) persists under the cache dir so a passed check or a
 *   login the person chose to do in that window is remembered. It is never the person's own Chrome
 *   profile (Chrome refuses automation on that anyway).
 *
 * Identity is by headers (`From:`/`X-Agent:`), by a UA suffix, or none — see config.ts. What is never
 * done in any mode: hiding `navigator.webdriver`, fingerprint changes, stealth patches, CAPTCHA
 * solving, credentials the tool holds. docs/SPECTRUM.md.
 */

import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { isIP } from "node:net";
import { dirname } from "node:path";
import type { Browser, BrowserContext, Page, Route } from "playwright";
import type { Audit } from "../audit.js";
import type { Settings } from "../config.js";
import { isChallengePage } from "./diagnose.js";
import { BlockedURL, isBlockedHostname, isPrivateAddress, normalizeUrl } from "./guard.js";

export interface Rendered {
  html: string;
  finalUrl: string;
  status: number;
  salvaged: boolean; // navigation timed out but we harvested what had rendered
  /** The tool profile already held cookies for this host before navigating (headed + session). */
  usedSession: boolean;
  /** A challenge was shown and the person dealt with it in the visible window. */
  handedOff: boolean;
}

export interface RenderOptions {
  /** Use the persistent tool profile (headed). Engine pages always do; page reads only with browserSession. */
  session?: boolean;
  /** Allow the human handoff on a challenge (headed + FEARCH_HANDOFF). Default true. */
  handoff?: boolean;
  /** Engine-specific challenge detector (gets the current URL too); default is the generic one. */
  isChallenge?: (html: string, status: number, url: string) => boolean;
  /** Wait (bounded) for this selector before judging the page, so a half-rendered page isn't mistaken for a challenge. */
  settleSelector?: string;
}

export class BrowserUnavailable extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BrowserUnavailable";
  }
}

const BLOCKED_RESOURCES = new Set(["image", "media", "font", "manifest", "texttrack", "eventsource", "websocket"]);

function proxyFromEnv(): { server: string; bypass?: string } | undefined {
  const env = process.env;
  const server = env.HTTPS_PROXY || env.https_proxy || env.HTTP_PROXY || env.http_proxy;
  if (!server) return undefined;
  const bypass = env.NO_PROXY || env.no_proxy;
  return bypass ? { server, bypass } : { server };
}

/**
 * The handoff loop, kept pure for testing: poll the page until it is no longer a challenge or the
 * person has run out of time. Returns the final HTML and whether the challenge was passed.
 */
export async function waitForHuman(
  poll: () => Promise<{ html: string; status: number; url: string }>,
  isChallenge: (html: string, status: number, url: string) => boolean,
  timeoutMs: number,
  intervalMs = 1000,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): Promise<{ html: string; status: number; url: string; passed: boolean }> {
  const deadline = Date.now() + timeoutMs;
  let last = await poll();
  while (isChallenge(last.html, last.status, last.url)) {
    if (Date.now() >= deadline) return { ...last, passed: false };
    await sleep(intervalMs);
    last = await poll();
  }
  return { ...last, passed: true };
}

export class BrowserRenderer {
  private browser: Browser | null = null;
  private plain: BrowserContext | null = null;
  private profile: BrowserContext | null = null;
  private launching: Promise<Browser> | null = null;
  private inFlight = 0;
  private userAgent = "";
  private channel = "";
  private idleTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly settings: Settings,
    private readonly audit: Audit,
  ) {}

  enabled(): boolean {
    return this.settings.browser !== "off";
  }

  get headed(): boolean {
    return this.settings.browser === "headed";
  }

  /** The exact User-Agent the browser sends. Empty until first launch. */
  get browserUserAgent(): string {
    return this.userAgent;
  }

  /** Which browser binary was launched ("chrome" = the installed one, "chromium" = bundled). */
  get browserChannel(): string {
    return this.channel;
  }

  /** Free the ~200 MB browser process after inactivity; it relaunches lazily (state is on disk). */
  private scheduleIdleClose(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      if (this.inFlight === 0) void this.close();
    }, this.headed ? 180_000 : 60_000);
    this.idleTimer.unref();
  }

  private async launch(): Promise<Browser> {
    if (this.browser) return this.browser;
    if (this.launching) return this.launching;
    this.launching = (async () => {
      let pw: typeof import("playwright");
      try {
        pw = await import("playwright");
      } catch (e) {
        throw new BrowserUnavailable(`Playwright is not installed (${(e as Error).message}).`);
      }
      const headless = !this.headed;
      // Headless: bundled Chromium in new-headless mode (ordinary Chrome UA, no "HeadlessChrome").
      // Headed: prefer the Chrome already installed (no download, receives the machine's enterprise
      // policy), else the bundled Chromium in a window. Playwright's default flags are kept —
      // including `--enable-automation`, which is how Chrome tells the person (infobar) and the site
      // (`navigator.webdriver`) that it is being driven.
      const channels = headless ? ["chromium"] : ["chrome", "chromium"];
      let lastErr = "";
      for (const channel of channels) {
        try {
          this.browser = await pw.chromium.launch({ headless, channel, proxy: proxyFromEnv() });
          this.channel = channel;
          break;
        } catch (e) {
          lastErr = (e as Error).message.split("\n")[0];
        }
      }
      if (!this.browser) {
        throw new BrowserUnavailable(`Chromium could not be launched (${lastErr}). Run: npx playwright install chromium`);
      }
      const probe = await this.browser.newContext();
      const page = await probe.newPage();
      const baseUa = (await page.evaluate(() => navigator.userAgent)).replace(/HeadlessChrome\//, "Chrome/");
      await probe.close();
      this.userAgent = baseUa;
      this.audit.log(
        "info",
        `browser tier ready (${this.channel} ${this.browser.version()}, ${headless ? "headless" : "headed"}); identity=${this.settings.browserIdentity}; UA: ${this.userAgent}` +
          (this.settings.browserIdentity === "none" ? "" : `; From: ${this.settings.uaContact || this.settings.uaInfoUrl}; X-Agent: ${this.settings.userAgent}`) +
          (this.headed ? `; handoff=${this.settings.handoff ? "on" : "off"}; session=${this.settings.browserSession ? "on" : "off"}` : ""),
      );
      return this.browser;
    })();
    try {
      return await this.launching;
    } finally {
      this.launching = null;
    }
  }

  private contextOptions(): Parameters<Browser["newContext"]>[0] {
    const headers: Record<string, string> = { "Accept-Language": "en-US,en;q=0.8" };
    if (this.settings.browserIdentity !== "none") {
      headers.From = this.settings.uaContact || this.settings.uaInfoUrl;
      headers["X-Agent"] = this.settings.userAgent;
    }
    return {
      userAgent: this.userAgent,
      locale: "en-US",
      javaScriptEnabled: true,
      acceptDownloads: false,
      serviceWorkers: "block",
      extraHTTPHeaders: headers,
      ...(this.headed ? { viewport: null } : {}),
    };
  }

  /**
   * `plain`: ephemeral (cookies live only while the browser process does). `profile`: headed only —
   * persisted to `browserStatePath` after each use so a passed challenge or a login the person did in
   * the window survives restarts. In headless mode both names resolve to the ephemeral context.
   */
  private async context(kind: "plain" | "profile"): Promise<BrowserContext> {
    const browser = await this.launch();
    if (kind === "profile" && this.headed) {
      if (this.profile) return this.profile;
      const path = this.settings.browserStatePath;
      const ctx = await browser.newContext({ ...this.contextOptions(), ...(existsSync(path) ? { storageState: path } : {}) });
      ctx.setDefaultTimeout(this.settings.browserTimeoutMs);
      await ctx.route("**/*", (route) => this.gate(route));
      this.profile = ctx;
      const cookies = await ctx.cookies();
      this.audit.log("info", `browser profile loaded from ${path}: ${cookies.length} cookie(s)${cookies.length ? ` for ${[...new Set(cookies.map((c) => c.domain))].join(", ")}` : ""}`);
      return ctx;
    }
    if (this.plain) return this.plain;
    const ctx = await browser.newContext(this.contextOptions());
    ctx.setDefaultTimeout(this.settings.browserTimeoutMs);
    await ctx.route("**/*", (route) => this.gate(route));
    this.plain = ctx;
    return ctx;
  }

  private async saveProfile(): Promise<void> {
    if (!this.profile) return;
    try {
      await mkdir(dirname(this.settings.browserStatePath), { recursive: true });
      const state = await this.profile.storageState({ path: this.settings.browserStatePath });
      this.audit.log("debug", `browser profile saved: ${state.cookies.length} cookie(s) (${state.cookies.map((c) => `${c.name}@${c.domain}`).join(", ").slice(0, 300)})`);
    } catch (e) {
      this.audit.log("warn", `could not persist browser profile: ${(e as Error).message}`);
    }
  }

  /** Does the tool profile hold cookies for this URL (i.e. would a read use the person's session)? */
  async hasSession(url: string): Promise<boolean> {
    if (!this.headed) return false;
    const ctx = await this.context("profile");
    return (await ctx.cookies(url)).length > 0;
  }

  /** Forget everything the tool profile holds (cookies, storage). */
  async clearProfile(): Promise<void> {
    await this.profile?.clearCookies();
    await this.profile?.close().catch(() => {});
    this.profile = null;
    const { rm } = await import("node:fs/promises");
    await rm(this.settings.browserStatePath, { force: true });
  }

  /**
   * Per-request gate: never non-http schemes; block private/internal targets; in headless mode also
   * skip images/media/fonts (bandwidth courtesy). Headed windows load everything — the person is
   * looking at the page, and a challenge needs its images.
   */
  private async gate(route: Route): Promise<void> {
    const req = route.request();
    let u: URL;
    try {
      u = new URL(req.url());
    } catch {
      return route.abort("blockedbyclient");
    }
    if (u.protocol !== "http:" && u.protocol !== "https:") return route.abort("blockedbyclient");
    if (!this.settings.allowPrivate) {
      const host = u.hostname.replace(/^\[|\]$/g, "");
      if (isBlockedHostname(host) || (isIP(host) && isPrivateAddress(host))) return route.abort("blockedbyclient");
    }
    if (!this.headed && BLOCKED_RESOURCES.has(req.resourceType())) return route.abort("blockedbyclient");
    return route.continue();
  }

  async render(url: string, opts: RenderOptions = {}): Promise<Rendered> {
    if (!this.enabled()) throw new BrowserUnavailable("browser tier disabled (FEARCH_BROWSER=off)");
    const target = normalizeUrl(url);
    const useProfile = this.headed && !!opts.session;
    const ctx = await this.context(useProfile ? "profile" : "plain");
    const usedSession = useProfile && (await ctx.cookies(target)).length > 0;
    if (this.inFlight >= this.settings.browserMaxConcurrent) {
      throw new BrowserUnavailable("browser tier busy; try again in a moment");
    }
    this.inFlight++;
    const started = Date.now();
    let page: Page | null = null;
    try {
      page = await ctx.newPage();
      let status = 0;
      let salvaged = false;
      const goto = async (u: string) => {
        const resp = await page!.goto(u, { waitUntil: "domcontentloaded", timeout: this.settings.browserTimeoutMs });
        status = resp?.status() ?? 0;
      };
      try {
        await goto(target);
      } catch (e) {
        const msg = (e as Error).message;
        if (/Timeout|ERR_ABORTED/i.test(msg)) {
          // Navigation timed out or was interrupted: harvest whatever rendered (fetcher-mcp's "timeout salvage").
          salvaged = true;
        } else if (target.startsWith("https://") && /ERR_SSL|ERR_CONNECTION|ERR_CERT|net::/i.test(msg)) {
          // Optimistic https upgrade failed to connect; try plain http once, on a fresh page
          // (the failed navigation leaves the old page heading to chrome-error://).
          await page.close().catch(() => {});
          page = await ctx.newPage();
          await goto("http://" + target.slice("https://".length));
        } else {
          throw e;
        }
      }
      // Give client-side rendering a moment: content container or network idle, whichever first, bounded.
      await Promise.race([
        page.waitForSelector("main, article, [role=main], #content, .content", { timeout: 4000 }).catch(() => {}),
        page.waitForLoadState("networkidle", { timeout: 4000 }).catch(() => {}),
      ]);
      if (opts.settleSelector) await page.waitForSelector(opts.settleSelector, { timeout: 5000 }).catch(() => {});
      let html = await page.content();
      let handedOff = false;
      const isChallenge = opts.isChallenge ?? isChallengePage;
      if (this.headed && this.settings.handoff && opts.handoff !== false && isChallenge(html, status, page.url())) {
        // The human handoff: bring the tab forward and wait for the person. Nothing is clicked, typed
        // or solved by the tool; it only watches for the page to stop being a challenge.
        this.audit.log("warn", `challenge on ${target}: handed to you in the browser window (waiting up to ${Math.round(this.settings.handoffTimeoutMs / 1000)} s)`);
        await page.bringToFront().catch(() => {});
        const p = page;
        const r = await waitForHuman(
          async () => ({ html: await p.content().catch(() => ""), status: 200, url: p.url() }),
          (h, s, u) => !h || isChallenge(h, s, u),
          this.settings.handoffTimeoutMs,
        );
        if (r.passed) {
          await Promise.race([p.waitForLoadState("networkidle", { timeout: 4000 }).catch(() => {}), new Promise((res) => setTimeout(res, 4000))]);
          html = await p.content();
          status = 200;
          handedOff = true;
          this.audit.log("info", `challenge on ${target} passed by you; continuing`);
        } else {
          this.audit.log("warn", `challenge on ${target} not passed within the handoff window`);
        }
      }
      const finalUrl = page.url();
      const finalHost = new URL(finalUrl).hostname.replace(/^\[|\]$/g, "");
      if (!this.settings.allowPrivate && (isBlockedHostname(finalHost) || (isIP(finalHost) && isPrivateAddress(finalHost)))) {
        throw new BlockedURL(`browser navigation ended at a private address (${finalUrl})`);
      }
      this.audit.record({
        url: target,
        status: status || "salvaged",
        bytes: html.length,
        provider: useProfile ? "browser (profile)" : "browser",
        ms: Date.now() - started,
        note: [salvaged ? "navigation timeout; harvested rendered content" : "", handedOff ? "challenge handed to the person" : "", usedSession ? "sent the person's session cookies" : ""].filter(Boolean).join("; ") || undefined,
      });
      return { html, finalUrl, status: status || 200, salvaged, usedSession, handedOff };
    } finally {
      this.inFlight--;
      await page?.close().catch(() => {});
      if (useProfile) await this.saveProfile();
      this.scheduleIdleClose();
    }
  }

  async close(): Promise<void> {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    await this.saveProfile();
    await this.plain?.close().catch(() => {});
    await this.profile?.close().catch(() => {});
    await this.browser?.close().catch(() => {});
    this.plain = null;
    this.profile = null;
    this.browser = null;
  }
}
