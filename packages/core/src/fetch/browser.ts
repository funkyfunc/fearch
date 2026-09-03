/**
 * Browser tier: a real Chromium (Playwright) used when the plain HTTP client either got an empty JS
 * shell or was refused, and for search-engine result pages. This class covers two of the four
 * browser modes (extension.ts covers `extension`; `off` disables the tier):
 *
 * - `headless` (default): the bundled Chromium in new-headless mode. No cookies survive the process.
 * - `headed`: the Chrome already installed on the machine (bundled Chromium if none), in a visible
 *   window. The person can see every tab the tool opens and (handoff, on by default) is handed a
 *   challenge page to deal with themselves — the tool waits, then continues with what they were
 *   shown. A tool-owned profile (cookies/storage) persists under the cache dir so a passed check or a
 *   login the person chose to do in that window is remembered. It is never the person's own Chrome
 *   profile (Chrome refuses automation on that anyway).
 *
 * Identity is by headers (`From:`/`X-Agent:`) on every request, always. What is never done in any
 * mode: hiding `navigator.webdriver`, fingerprint changes, stealth patches, CAPTCHA solving,
 * credentials the tool holds. docs/SPECTRUM.md.
 */

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { isIP } from "node:net";
import { dirname } from "node:path";
import type { Browser, BrowserContext, Page, Route } from "playwright";
import type { Audit } from "../audit.js";
import type { AppEvents } from "../app.js";
import { acceptLanguage, type Settings } from "../config.js";
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
  /** Where a challenge was handed to the person (whether or not they passed it), e.g. "a tab in your Chrome". */
  handoffWhere?: string;
  /** Extra provenance shown in the result header (e.g. "your Chrome"). */
  label?: string;
}

/** What the pipeline and the engines need from a browser tier; BrowserRenderer and ExtensionRenderer both provide it. */
export interface BrowserTier {
  enabled(): boolean;
  readonly headed: boolean;
  readonly browserUserAgent: string;
  readonly browserChannel: string;
  render(url: string, opts?: RenderOptions): Promise<Rendered>;
  close(): Promise<void>;
}

export interface RenderOptions {
  /** Use the persistent tool profile (headed/auto). Engine pages do (a passed check lives there); page reads never. */
  session?: boolean;
  /** Allow the human handoff on a challenge (visible browser, handoff on). Default true. */
  handoff?: boolean;
  /** The URL was upgraded to https optimistically; plain http may be tried if https cannot connect. */
  httpFallback?: boolean;
  /**
   * Open the page for the person straight away and wait until `ready` says they have done their part
   * (e.g. pressed Enter on a prefilled search box). Needs a visible browser; `message` is what they are
   * told. The result reports `handedOff` when `ready` was reached in time.
   */
  handToPerson?: { message: string; ready: (html: string, url: string) => boolean };
  /** Engine-specific challenge detector (gets the current URL too); default is the generic one. */
  isChallenge?: (html: string, status: number, url: string) => boolean;
  /** Wait (bounded) for this selector before judging the page, so a half-rendered page isn't mistaken for a challenge. */
  settleSelector?: string;
  /** Keep re-reading (bounded by settleUntilMs) until this returns true — for content that streams in after load. */
  settleUntil?: (html: string) => boolean;
  settleUntilMs?: number;
}

export class BrowserUnavailable extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BrowserUnavailable";
  }
}

const BLOCKED_RESOURCES = new Set(["image", "media", "font", "manifest", "texttrack", "eventsource", "websocket"]);

/** One-time lazy download of the bundled Chromium (replaces a postinstall every installer would pay). */
async function installChromium(audit: Audit): Promise<boolean> {
  let cli: string;
  try {
    cli = createRequire(import.meta.url).resolve("playwright/cli");
  } catch {
    return false;
  }
  audit.log("warn", "Chromium is not installed yet — downloading it now (one-time, ~100 MB)…");
  const ok = await new Promise<boolean>((resolve) => {
    execFile(process.execPath, [cli, "install", "chromium"], { timeout: 600_000 }, (err) => resolve(!err));
  });
  audit.log(
    ok ? "info" : "warn",
    ok ? "Chromium installed" : "Chromium download failed; the browser tier stays unavailable",
  );
  return ok;
}

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

export class BrowserRenderer implements BrowserTier {
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
    private readonly events?: AppEvents,
  ) {}

  enabled(): boolean {
    return this.settings.browser !== "off";
  }

  get headed(): boolean {
    return this.settings.browser === "headed";
  }

  /**
   * Whether the persistent tool profile may be used. Headed always; `auto` too — its routine renders
   * are headless, but a check the person passed in an escalation window lives in that profile, and
   * carrying it means the window does not have to reappear. Explicit `headless` stays stateless.
   */
  private get profileAllowed(): boolean {
    return this.headed || this.settings.browser === "auto";
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
    this.idleTimer = setTimeout(
      () => {
        if (this.inFlight === 0) void this.close();
      },
      this.headed ? 180_000 : 60_000,
    );
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
      const tryLaunch = async () => {
        for (const channel of channels) {
          try {
            this.browser = await pw.chromium.launch({ headless, channel, proxy: proxyFromEnv() });
            this.channel = channel;
            return;
          } catch (e) {
            lastErr = (e as Error).message.split("\n")[0];
          }
        }
      };
      await tryLaunch();
      // The bundled Chromium is downloaded lazily on first need, not in a postinstall (which would
      // cost every installer ~100 MB whether or not they ever use the browser tier).
      if (!this.browser && /doesn't exist|does not exist|install/i.test(lastErr) && (await installChromium(this.audit)))
        await tryLaunch();
      if (!this.browser) {
        throw new BrowserUnavailable(
          `Chromium could not be launched (${lastErr}). Run: npx playwright install chromium`,
        );
      }
      const probe = await this.browser.newContext();
      const page = await probe.newPage();
      const baseUa = (await page.evaluate(() => navigator.userAgent)).replace(/HeadlessChrome\//, "Chrome/");
      await probe.close();
      this.userAgent = baseUa;
      this.audit.log(
        "info",
        `browser tier ready (${this.channel} ${this.browser.version()}, ${headless ? "headless" : "headed"}); UA: ${this.userAgent}; From: ${this.settings.uaContact || this.settings.uaInfoUrl}; X-Agent: ${this.settings.userAgent}` +
          (this.headed ? `; handoff=${this.settings.handoff ? "on" : "off"}` : ""),
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
    const headers: Record<string, string> = {
      "Accept-Language": acceptLanguage(this.settings.locale),
      From: this.settings.uaContact || this.settings.uaInfoUrl,
      "X-Agent": this.settings.userAgent,
    };
    return {
      userAgent: this.userAgent,
      locale: this.settings.locale,
      javaScriptEnabled: true,
      acceptDownloads: false,
      serviceWorkers: "block",
      extraHTTPHeaders: headers,
      ...(this.headed ? { viewport: null } : {}),
    };
  }

  /**
   * `plain`: ephemeral (cookies live only while the browser process does). `profile`: headed or auto —
   * persisted to `browserStatePath` after each use so a passed challenge or a login the person did in
   * the window survives restarts. In explicit headless mode both names resolve to the ephemeral context.
   */
  private async context(kind: "plain" | "profile"): Promise<BrowserContext> {
    const browser = await this.launch();
    if (kind === "profile" && this.profileAllowed) {
      if (this.profile) return this.profile;
      const path = this.settings.browserStatePath;
      const ctx = await browser.newContext({
        ...this.contextOptions(),
        ...(existsSync(path) ? { storageState: path } : {}),
      });
      ctx.setDefaultTimeout(this.settings.browserTimeoutMs);
      await ctx.route("**/*", (route) => this.gate(route));
      this.profile = ctx;
      const cookies = await ctx.cookies();
      this.audit.log(
        "info",
        `browser profile loaded from ${path}: ${cookies.length} cookie(s)${cookies.length ? ` for ${[...new Set(cookies.map((c) => c.domain))].join(", ")}` : ""}`,
      );
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
      this.audit.log(
        "debug",
        `browser profile saved: ${state.cookies.length} cookie(s) (${state.cookies
          .map((c) => `${c.name}@${c.domain}`)
          .join(", ")
          .slice(0, 300)})`,
      );
    } catch (e) {
      this.audit.log("warn", `could not persist browser profile: ${(e as Error).message}`);
    }
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
    if (!this.enabled()) throw new BrowserUnavailable("browser tier disabled (--browser off)");
    if (opts.handToPerson && !this.headed)
      throw new BrowserUnavailable("handing a page to the person needs a visible browser (headed or the extension)");
    const target = normalizeUrl(url);
    const useProfile = this.profileAllowed && !!opts.session;
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
        } else if (
          opts.httpFallback &&
          target.startsWith("https://") &&
          /ERR_CONNECTION|ERR_SSL_PROTOCOL_ERROR|ERR_SSL_VERSION|net::ERR_(ADDRESS|NAME|SOCKET)/i.test(msg) &&
          !/ERR_CERT/i.test(msg)
        ) {
          // Optimistic https upgrade failed to connect; try plain http once, on a fresh page
          // (the failed navigation leaves the old page heading to chrome-error://). Never for an
          // explicit https URL, never on a certificate error (same rule as the plain transport).
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
      if (opts.settleUntil) {
        const deadline = Date.now() + (opts.settleUntilMs ?? 2500);
        while (!opts.settleUntil(html) && Date.now() < deadline) {
          await new Promise((res) => setTimeout(res, 400));
          html = await page.content();
        }
      }
      let handedOff = false;
      let handoffWhere: string | undefined;
      const isChallenge = opts.isChallenge ?? isChallengePage;
      if (opts.handToPerson) {
        // The person's turn from the start: show the page, say what to do, wait for `ready`.
        handoffWhere = "a browser window on your screen";
        this.audit.log("warn", `${target}: handed to you (${opts.handToPerson.message})`);
        this.events?.emit("handoff", { url: target, where: handoffWhere, message: opts.handToPerson.message });
        await page.bringToFront().catch(() => {});
        const p = page;
        const ready = opts.handToPerson.ready;
        const r = await waitForHuman(
          async () => ({ html: await p.content().catch(() => ""), status: 200, url: p.url() }),
          (h, _s, u) => !h || !ready(h, u),
          this.settings.handoffTimeoutMs,
        );
        html = r.html;
        status = 200;
        handedOff = r.passed;
        this.audit.log(
          r.passed ? "info" : "warn",
          `${target}: ${r.passed ? "done by you; continuing" : "not done within the handoff window"}`,
        );
        this.events?.emit("handoff-end", { url: target, passed: r.passed });
      } else if (
        this.headed &&
        this.settings.handoff &&
        opts.handoff !== false &&
        isChallenge(html, status, page.url())
      ) {
        handoffWhere = "a browser window on your screen";
        // The human handoff: bring the tab forward and wait for the person. Nothing is clicked, typed
        // or solved by the tool; it only watches for the page to stop being a challenge.
        this.audit.log(
          "warn",
          `challenge on ${target}: handed to you in the browser window (waiting up to ${Math.round(this.settings.handoffTimeoutMs / 1000)} s)`,
        );
        this.events?.emit("handoff", { url: target, where: handoffWhere });
        await page.bringToFront().catch(() => {});
        const p = page;
        const r = await waitForHuman(
          async () => ({ html: await p.content().catch(() => ""), status: 200, url: p.url() }),
          (h, s, u) => !h || isChallenge(h, s, u),
          this.settings.handoffTimeoutMs,
        );
        if (r.passed) {
          await Promise.race([
            p.waitForLoadState("networkidle", { timeout: 4000 }).catch(() => {}),
            new Promise((res) => setTimeout(res, 4000)),
          ]);
          html = await p.content();
          status = 200;
          handedOff = true;
          this.audit.log("info", `challenge on ${target} passed by you; continuing`);
        } else {
          this.audit.log("warn", `challenge on ${target} not passed within the handoff window`);
        }
        this.events?.emit("handoff-end", { url: target, passed: r.passed });
      }
      const finalUrl = page.url();
      const finalHost = new URL(finalUrl).hostname.replace(/^\[|\]$/g, "");
      if (
        !this.settings.allowPrivate &&
        (isBlockedHostname(finalHost) || (isIP(finalHost) && isPrivateAddress(finalHost)))
      ) {
        throw new BlockedURL(`browser navigation ended at a private address (${finalUrl})`);
      }
      this.audit.record({
        url: target,
        status: status || "salvaged",
        bytes: html.length,
        provider: useProfile ? "browser (profile)" : "browser",
        ms: Date.now() - started,
        note:
          [
            salvaged ? "navigation timeout; harvested rendered content" : "",
            handedOff ? "challenge handed to the person" : "",
            usedSession ? "sent the person's session cookies" : "",
          ]
            .filter(Boolean)
            .join("; ") || undefined,
      });
      return { html, finalUrl, status: status || 200, salvaged, usedSession, handedOff, handoffWhere };
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

/** How long to stop opening windows (or activating tabs) after one goes unanswered — the person is evidently away. */
export const AWAY_COOLDOWN_MS = 10 * 60_000;

/**
 * The `auto` tier: headless until it matters. Routine renders happen invisibly (with the tool
 * profile, so a passed check stays passed); when a page comes back as a challenge, the same URL is
 * opened once in a visible window and handed to the person. If the window goes unanswered, no more
 * windows for a while; if no window can be opened at all (no display, no Chrome), the challenge is
 * final exactly as in headless mode. Nothing is ever clicked or solved by the tool.
 */
export class EscalatingRenderer implements BrowserTier {
  readonly browserChannel = "auto";
  readonly headed = false;
  private escalation: BrowserTier | null = null;
  private cannotEscalate = false;
  private awayUntil = 0;

  constructor(
    private readonly settings: Settings,
    private readonly audit: Audit,
    private readonly routine: BrowserTier,
    private readonly makeEscalation: () => BrowserTier = () =>
      new BrowserRenderer({ ...settings, browser: "headed" }, audit, events),
    private readonly events?: AppEvents,
  ) {}

  enabled(): boolean {
    return true;
  }

  get browserUserAgent(): string {
    return this.routine.browserUserAgent;
  }

  private canEscalate(): boolean {
    return this.settings.canSurface && this.settings.handoff && !this.cannotEscalate && Date.now() >= this.awayUntil;
  }

  async render(url: string, opts: RenderOptions = {}): Promise<Rendered> {
    // A page meant for the person's hands skips the headless attempt entirely.
    if (opts.handToPerson) {
      if (!this.canEscalate())
        throw new BrowserUnavailable("no visible window can be shown here to hand the page to you");
      this.escalation ??= this.makeEscalation();
      return this.escalation.render(url, { ...opts, session: true, handoff: true });
    }
    // Always with the tool profile: it holds only what the person did in escalation windows, and
    // carrying it is what keeps a passed check passed — the window must not reappear per page.
    const first = await this.routine.render(url, { ...opts, session: true, handoff: false });
    const isChallenge = opts.isChallenge ?? isChallengePage;
    if (!isChallenge(first.html, first.status, first.finalUrl) || opts.handoff === false || !this.canEscalate()) {
      return first;
    }
    this.audit.log("warn", `challenge on ${url}: opening it in a visible window for you to deal with`);
    let second: Rendered;
    try {
      this.escalation ??= this.makeEscalation();
      // session:true so what the person passes lands in the shared profile and the window need not reappear.
      second = await this.escalation.render(url, { ...opts, session: true, handoff: true });
    } catch (e) {
      const msg = (e as Error).message;
      // A window that cannot be opened here (no display, no Chrome) will not open next time either.
      if (/could not be launched|not installed/i.test(msg)) this.cannotEscalate = true;
      this.audit.log("warn", `no visible window could be opened (${msg.split("\n")[0]}); the challenge stands`);
      return first;
    }
    if (second.handedOff) {
      // The person passed the check; restart the routine renderer so its next context loads the
      // updated profile state instead of the pre-clearance cookies it launched with.
      await this.routine.close().catch(() => {});
      return second;
    }
    if (isChallenge(second.html, second.status, second.finalUrl)) {
      this.awayUntil = Date.now() + AWAY_COOLDOWN_MS;
      this.audit.log(
        "warn",
        `the window went unanswered; not opening another for ${Math.round(AWAY_COOLDOWN_MS / 60_000)} min`,
      );
      // Close the window rather than orphan it: a dead page must not sit there collecting a click
      // whose request has already given up.
      await this.escalation?.close().catch(() => {});
      this.escalation = null;
    }
    return second;
  }

  async close(): Promise<void> {
    await this.routine.close();
    await this.escalation?.close().catch(() => {});
  }
}
