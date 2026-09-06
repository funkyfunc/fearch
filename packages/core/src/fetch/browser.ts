/**
 * Browser tier: a real Chromium (Playwright) used when the plain HTTP client either got an empty JS
 * shell or was refused, and for search-engine result pages. This class covers two of the four
 * browser modes (extension.ts covers `extension`; `off` disables the tier):
 *
 * - `headless` (default): the bundled Chromium in new-headless mode. No cookies survive the process.
 * - visible (`auto`'s escalation and engine window; `visible` in the constructor): the Chrome already
 *   installed on the machine (bundled Chromium if none), in a window. The person is handed a
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
import type { Browser, BrowserContext, CDPSession, Page, Route } from "playwright";
import type { Audit } from "../audit.js";
import type { AppEvents } from "../app.js";
import { acceptLanguage, type Settings } from "../config.js";
import { isChallengePage } from "./diagnose.js";
import { BlockedURL, isBlockedHostname, isPrivateAddress, normalizeUrl } from "./guard.js";

/**
 * What became of a bot check: `passed` (the person cleared it), `timeout` (they said yes but it was
 * not passed in time), `declined` (they said no), `none` (no check, or nothing could be surfaced).
 * A prompt nobody answers never reaches a tier: the client reports the timed-out round and the
 * suspended render expires (see `PendingChecks`).
 */
export type HandoffOutcome = "passed" | "timeout" | "declined" | "none";

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
  handoff?: HandoffOutcome;
  /** Extra provenance shown in the result header (e.g. "your Chrome"). */
  label?: string;
}

export type HandoffAnswer = "accept" | "declined" | "unavailable";

/**
 * How a suspended render continues once the person has answered: `resume("accept")` brings the check
 * in front of them, waits, and completes the render; `resume("declined")` completes it as declined;
 * `cancel()` closes the page nobody came back for.
 */
export interface HandoffContinuation {
  resume(answer: "accept" | "declined"): Promise<Rendered>;
  cancel(): Promise<void>;
}

/**
 * Asks the person, through their MCP client, whether to bring a bot check in front of them. Resolves
 * an answer, `unavailable` (the client cannot ask — then the tab or window is surfaced straight away,
 * as the only channel left), or `{ deferred }` when the question travels as an `input_required`
 * result: the render is suspended (its continuation registered under that id) and resumed by the
 * client's next call.
 */
export type HandoffAsk = (
  info: { url: string; where: string; message?: string },
  cont?: HandoffContinuation,
) => Promise<HandoffAnswer | { deferred: string }>;

/** The server installs the ask here; renderers read it at handoff time. */
export interface HandoffGate {
  ask?: HandoffAsk;
  /** Whether the client of the current call can show a prompt (set by the tool handlers per call). */
  askable?: boolean;
}

/** Thrown by a render that was suspended on a bot check; the tool turns it into `input_required`. */
export class HandoffPending extends Error {
  constructor(
    readonly id: string,
    readonly url: string,
    readonly where: string,
  ) {
    super(`bot check on ${url} is waiting for the person's answer (${id})`);
    this.name = "HandoffPending";
  }
}

/** When nobody can be asked, the tab or window is surfaced immediately (the pre-gate behaviour). */
export async function askToSurface(
  gate: HandoffGate | undefined,
  info: { url: string; where: string; message?: string },
  cont?: HandoffContinuation,
): Promise<HandoffAnswer | { deferred: string }> {
  if (!gate?.ask) return "unavailable";
  try {
    const a = await gate.ask(info, cont);
    return typeof a === "object" && !cont ? "unavailable" : a;
  } catch {
    return "unavailable";
  }
}

/** What the pipeline and the engines need from a browser tier; BrowserRenderer and ExtensionRenderer both provide it. */
export interface BrowserTier {
  enabled(): boolean;
  readonly headed: boolean;
  readonly browserUserAgent: string;
  readonly browserChannel: string;
  /**
   * Which profile an engine page would open in, so the query form can offer "profile or incognito":
   * `own-chrome` (the person's signed-in Chrome via the extension), `tool-profile` (the tool-owned
   * profile of the installed Chrome: passed checks, logins done in its windows), or null (headless: no choice).
   */
  profileChoice?(): "own-chrome" | "tool-profile" | null;
  /** Whether Chrome lets the extension open incognito windows ("Allow in Incognito"); undefined until known. */
  incognitoAllowed?(): boolean | undefined;
  /** Get ready to answer `profileChoice`/`incognitoAllowed` (the extension tier waits for its first poll). */
  prepare?(): Promise<void>;
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
  /** Per-render override of `--incognito` (the person's choice in the query form). Extension tier only. */
  incognito?: boolean;
  /** The person already said yes to seeing this check (an outer tier asked); do not ask again. */
  handoffApproved?: boolean;
  /**
   * Visible tier only: open the window off-screen and bring it forward only when the person says yes to a
   * check (or must press Enter). Engine result pages use this — a real browser, not a visible one.
   */
  background?: boolean;
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

/**
 * Where the background engine window lives: as far left as Chrome will put it (it clamps the value so
 * a strip stays on some display). `ONSCREEN` is where a handoff brings it.
 */
const OFFSCREEN = { left: -10_000, top: 0, width: 1200, height: 800 };
const ONSCREEN = { left: 120, top: 80, width: 1200, height: 800 };

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
  /** A browser-level CDP session (Chromium only), for creating windows and tabs off to the side. */
  private browserCdp: CDPSession | null = null;
  /** Playwright contexts → their CDP browserContextId, learned by diffing `Target.getBrowserContexts`. */
  private readonly contextIds = new WeakMap<BrowserContext, string>();
  /** The blank tab that keeps the one background window alive; engine pages open as tabs beside it. */
  private anchor: Page | null = null;
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
    private readonly handoffGate?: HandoffGate,
    /** A window on the person's screen rather than headless: the escalation and engine tier of `auto`. */
    private readonly visible = false,
  ) {}

  enabled(): boolean {
    return this.settings.browser !== "off";
  }

  get headed(): boolean {
    return this.visible;
  }

  /**
   * Whether the persistent tool profile may be used. The visible window always; `auto` too — its routine renders
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

  profileChoice(): "tool-profile" | null {
    return this.profileAllowed ? "tool-profile" : null;
  }

  /** Which browser binary was launched ("chrome" = the installed one, "chromium" = bundled). */
  get browserChannel(): string {
    return this.channel;
  }

  /** Free the ~200 MB browser process after inactivity; it relaunches lazily (state is on disk). */
  private scheduleIdleClose(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    // A background engine window is opened once per browser session and may show on some display
    // arrangements, so the browser that holds one stays up for 20 min of idle rather than 3.
    const engineWindow = !!this.anchor && !this.anchor.isClosed();
    this.idleTimer = setTimeout(
      () => {
        if (this.inFlight === 0) void this.close();
      },
      this.headed ? (engineWindow ? 20 * 60_000 : 180_000) : 60_000,
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
      // Headless: the bundled Chromium in new-headless mode, for page reads only; it reports itself
      // as HeadlessChrome and that is what sites see — nothing about the browser is edited.
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
      // Read the UA the browser sends, for doctor and the log; it is never set or edited. Asked of
      // the browser itself over CDP — opening a page for it would flash a window in headed mode.
      this.userAgent = await this.reportedUserAgent(this.browser);
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
      const ctx = await this.trackedContext(browser, {
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
    const ctx = await this.trackedContext(browser, this.contextOptions());
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

  /**
   * `browser.newContext()` plus the CDP id Chromium gave it, found by diffing the context list around
   * the call (Playwright does not expose the id). Best effort: without it a background page is
   * created visible and moved aside a moment later.
   */
  private async trackedContext(
    browser: Browser,
    options: Parameters<Browser["newContext"]>[0],
  ): Promise<BrowserContext> {
    const before = await this.browserContextIds();
    const ctx = await browser.newContext(options);
    if (before) {
      const after = await this.browserContextIds();
      const fresh = after?.filter((id) => !before.includes(id)) ?? [];
      if (fresh.length === 1) this.contextIds.set(ctx, fresh[0]);
    }
    return ctx;
  }

  private async reportedUserAgent(browser: Browser): Promise<string> {
    try {
      this.browserCdp ??= await (
        browser as Browser & { newBrowserCDPSession(): Promise<CDPSession> }
      ).newBrowserCDPSession();
      const v = (await this.browserCdp.send("Browser.getVersion")) as { userAgent: string };
      if (v.userAgent) return v.userAgent;
    } catch {
      // not Chromium over CDP: fall through to a page
    }
    const probe = await browser.newContext();
    const page = await probe.newPage();
    const ua = await page.evaluate(() => navigator.userAgent);
    await probe.close();
    return ua;
  }

  private async browserContextIds(): Promise<string[] | null> {
    try {
      this.browserCdp ??= await (
        this.browser as Browser & { newBrowserCDPSession(): Promise<CDPSession> }
      ).newBrowserCDPSession();
      const r = (await this.browserCdp.send("Target.getBrowserContexts")) as { browserContextIds: string[] };
      return r.browserContextIds;
    } catch {
      return null;
    }
  }

  /**
   * A page for an engine result: a background tab in the one engine window, which is created once
   * per browser session — `Target.createTarget` with a far-left position — and kept alive by a blank
   * anchor tab. Measured 2026-09-05 on macOS: a window created *minimised* still shows (the minimise
   * is animated); an off-screen one is clamped by Chrome to leave a strip on some display, so it can
   * show on a multi-display desk — once, when Chrome starts, never per search. Falls back to a
   * visible page moved aside when the browser does not take the parameters.
   */
  private async newBackgroundPage(ctx: BrowserContext): Promise<Page> {
    const id = this.contextIds.get(ctx);
    if (id && this.browserCdp) {
      try {
        if (!this.anchor || this.anchor.isClosed() || this.anchor.context() !== ctx) {
          const opened = ctx.waitForEvent("page", { timeout: 10_000 });
          const { targetId } = (await this.browserCdp.send("Target.createTarget", {
            url: "about:blank",
            browserContextId: id,
            newWindow: true,
            background: true,
            ...OFFSCREEN,
          })) as { targetId: string };
          this.anchor = await opened;
          try {
            const w = (await this.browserCdp.send("Browser.getWindowForTarget", { targetId })) as {
              bounds: { left?: number; top?: number; width?: number };
            };
            this.audit.log("debug", `engine window created once for this session at ${JSON.stringify(w.bounds)}`);
          } catch {
            // informational only
          }
        }
        const opened = ctx.waitForEvent("page", { timeout: 10_000 });
        await this.browserCdp.send("Target.createTarget", {
          url: "about:blank",
          browserContextId: id,
          newWindow: false,
          background: true,
        });
        return await opened;
      } catch (e) {
        this.audit.log(
          "debug",
          `background tab creation unavailable (${(e as Error).message.split("\n")[0]}); opening a page and moving it aside`,
        );
      }
    }
    const page = await ctx.newPage();
    await this.setWindowBounds(page, OFFSCREEN);
    return page;
  }

  /** Bring a background window in front of the person: on-screen, normal state, focused. */
  private async showWindow(page: Page): Promise<void> {
    await this.setWindowBounds(page, ONSCREEN);
    await this.setWindowBounds(page, { windowState: "normal" });
    await page.bringToFront().catch(() => {});
  }

  /** Move or restore the window a page lives in (CDP; best effort — a headless page has no window). */
  private async setWindowBounds(
    page: Page,
    bounds: { left?: number; top?: number; width?: number; height?: number; windowState?: "minimized" | "normal" },
  ): Promise<void> {
    if (!this.headed) return;
    try {
      const cdp = await page.context().newCDPSession(page);
      const { windowId } = (await cdp.send("Browser.getWindowForTarget")) as { windowId: number };
      await cdp.send("Browser.setWindowBounds", { windowId, bounds });
      await cdp.detach();
    } catch {
      // not Chromium, or the window is gone: the page still renders
    }
  }

  async render(url: string, opts: RenderOptions = {}): Promise<Rendered> {
    if (!this.enabled()) throw new BrowserUnavailable("browser tier disabled (--browser off)");
    if (opts.handToPerson && !this.headed)
      throw new BrowserUnavailable("handing a page to the person needs a visible browser (headed or the extension)");
    const target = normalizeUrl(url);
    // The person chose incognito for this engine page: a context of its own, closed when the page is,
    // so nothing from the tool profile rides along and nothing is kept.
    const incognito = !!opts.session && opts.incognito === true;
    const useProfile = this.profileAllowed && !!opts.session && !incognito;
    const ctx = incognito ? await this.freshContext() : await this.context(useProfile ? "profile" : "plain");
    const usedSession = useProfile && (await ctx.cookies(target)).length > 0;
    if (this.inFlight >= this.settings.browserMaxConcurrent) {
      throw new BrowserUnavailable("browser tier busy; try again in a moment");
    }
    this.inFlight++;
    const started = Date.now();
    let page: Page | null = null;
    let deferred = false;
    let cleaned = false;
    const cleanup = async () => {
      if (cleaned) return;
      cleaned = true;
      this.inFlight--;
      await page?.close().catch(() => {});
      if (incognito) await ctx.close().catch(() => {});
      if (useProfile) await this.saveProfile();
      this.scheduleIdleClose();
    };
    try {
      page = opts.background && this.headed ? await this.newBackgroundPage(ctx) : await ctx.newPage();
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
      let handoff: HandoffOutcome = "none";
      const isChallenge = opts.isChallenge ?? isChallengePage;
      /** The end of a render: the private-address check, the audit line, the result. */
      const finishRender = (): Rendered => {
        const finalUrl = page!.url();
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
        return { html, finalUrl, status: status || 200, salvaged, usedSession, handedOff, handoffWhere, handoff };
      };
      if (opts.handToPerson) {
        // The person's turn from the start: show the page, say what to do, wait for `ready`.
        handoffWhere = "a browser window on your screen";
        this.audit.log("warn", `${target}: handed to you (${opts.handToPerson.message})`);
        this.events?.emit("handoff", { url: target, where: handoffWhere, message: opts.handToPerson.message });
        await this.showWindow(page);
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
        handoff = r.passed ? "passed" : "timeout";
        this.audit.log(
          r.passed ? "info" : "warn",
          `${target}: ${r.passed ? "done by you; continuing" : "not done within the handoff window"}`,
        );
        this.events?.emit("handoff-end", { url: target, passed: r.passed });
        if (opts.background) await this.setWindowBounds(page, OFFSCREEN);
      } else if (
        this.headed &&
        this.settings.handoff &&
        opts.handoff !== false &&
        isChallenge(html, status, page.url())
      ) {
        handoffWhere = "a browser window on your screen";
        const p = page;
        const where = handoffWhere;
        // The human handoff: bring the window forward and wait for the person. Nothing is clicked,
        // typed or solved by the tool; it only watches for the page to stop being a challenge.
        const runHandoff = async (answer: "accept" | "declined"): Promise<void> => {
          if (answer === "declined") {
            handoff = "declined";
            this.audit.log("warn", `challenge on ${target}: you declined to see it`);
            return;
          }
          this.audit.log(
            "warn",
            `challenge on ${target}: handed to you in the browser window (waiting up to ${Math.round(this.settings.challengeTimeoutMs / 1000)} s)`,
          );
          this.events?.emit("handoff", { url: target, where });
          await this.showWindow(p);
          const r = await waitForHuman(
            async () => ({ html: await p.content().catch(() => ""), status: 200, url: p.url() }),
            (h, s, u) => !h || isChallenge(h, s, u),
            this.settings.challengeTimeoutMs,
          );
          if (r.passed) {
            await Promise.race([
              p.waitForLoadState("networkidle", { timeout: 4000 }).catch(() => {}),
              new Promise((res) => setTimeout(res, 4000)),
            ]);
            html = await p.content();
            status = 200;
            handedOff = true;
            handoff = "passed";
            this.audit.log("info", `challenge on ${target} passed by you; continuing`);
          } else {
            handoff = "timeout";
            this.audit.log("warn", `challenge on ${target} not passed within the handoff window`);
          }
          this.events?.emit("handoff-end", { url: target, passed: r.passed });
          if (opts.background) await this.setWindowBounds(p, OFFSCREEN);
        };
        // Ask first, through the client: a person who is there says yes and the window comes to the
        // front; a person who is away does not get a window fought for on their desktop. When the
        // question travels as an input_required result, this render is suspended until the answer.
        const answer = opts.handoffApproved
          ? "accept"
          : await askToSurface(
              this.handoffGate,
              { url: target, where },
              {
                resume: async (a) => {
                  try {
                    await runHandoff(a);
                    return finishRender();
                  } finally {
                    await cleanup();
                  }
                },
                cancel: cleanup,
              },
            );
        if (typeof answer === "object") {
          deferred = true;
          throw new HandoffPending(answer.deferred, target, where);
        }
        await runHandoff(answer === "declined" ? "declined" : "accept");
      }
      return finishRender();
    } finally {
      if (!deferred) await cleanup();
    }
  }

  /** A one-off context with nothing in it, for an engine page the person wants incognito. */
  private async freshContext(): Promise<BrowserContext> {
    const browser = await this.launch();
    const ctx = await this.trackedContext(browser, this.contextOptions());
    ctx.setDefaultTimeout(this.settings.browserTimeoutMs);
    await ctx.route("**/*", (route) => this.gate(route));
    return ctx;
  }

  async close(): Promise<void> {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    await this.saveProfile();
    this.anchor = null;
    await this.browserCdp?.detach().catch(() => {});
    this.browserCdp = null;
    await this.plain?.close().catch(() => {});
    await this.profile?.close().catch(() => {});
    await this.browser?.close().catch(() => {});
    this.plain = null;
    this.profile = null;
    this.browser = null;
  }
}

/**
 * How long to stop opening windows (or activating tabs) after one goes unanswered *when nobody could
 * be asked first* — the person is evidently away. With a client that can ask, the prompt is the test
 * of presence and nothing is opened until they say yes, so no backoff is needed.
 */
export const AWAY_COOLDOWN_MS = 10 * 60_000;

/**
 * The `auto` tier: headless until it matters. Routine renders happen invisibly (with the tool
 * profile, so a passed check stays passed); when a page comes back as a challenge, the person is
 * asked, and on yes the same URL is opened once in a visible window and handed to them. If no window
 * can be opened at all (no display, no Chrome), the challenge is final exactly as in headless mode.
 * Nothing is ever clicked or solved by the tool.
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
      new BrowserRenderer(settings, audit, events, handoffGate, true),
    private readonly events?: AppEvents,
    private readonly handoffGate?: HandoffGate,
  ) {}

  enabled(): boolean {
    return true;
  }

  get browserUserAgent(): string {
    return this.routine.browserUserAgent;
  }

  profileChoice(): "tool-profile" | null {
    return this.canShow() ? "tool-profile" : null;
  }

  /** A real window could be opened here at all (a display exists; Chrome launched last time). */
  private canShow(): boolean {
    return this.settings.canSurface && !this.cannotEscalate;
  }

  private canEscalate(): boolean {
    return this.canShow() && this.settings.handoff && Date.now() >= this.awayUntil;
  }

  async render(url: string, opts: RenderOptions = {}): Promise<Rendered> {
    // A page meant for the person's hands skips the headless attempt entirely.
    if (opts.handToPerson) {
      if (!this.canEscalate())
        throw new BrowserUnavailable("no visible window can be shown here to hand the page to you");
      this.escalation ??= this.makeEscalation();
      return this.escalation.render(url, { ...opts, session: true, handoff: true });
    }
    // An engine result page is the person's browsing and never headless: it opens in the installed
    // Chrome with the tool profile, kept off to the side, and comes forward only when a check needs them.
    if (opts.session) {
      if (!this.canShow())
        throw new BrowserUnavailable("engine result pages need a browser window and none can be shown here");
      this.escalation ??= this.makeEscalation();
      try {
        return await this.escalation.render(url, {
          ...opts,
          session: true,
          background: true,
          handoff: opts.handoff !== false && this.settings.handoff,
        });
      } catch (e) {
        if (/could not be launched|not installed/i.test((e as Error).message)) this.cannotEscalate = true;
        throw e;
      }
    }
    // Always with the tool profile: it holds only what the person did in escalation windows, and
    // carrying it is what keeps a passed check passed — the window must not reappear per page.
    const first = await this.routine.render(url, { ...opts, session: true, handoff: false });
    const isChallenge = opts.isChallenge ?? isChallengePage;
    if (!isChallenge(first.html, first.status, first.finalUrl) || opts.handoff === false || !this.canEscalate()) {
      return first;
    }
    const where = "a browser window on your screen";
    const declined = (): Rendered => {
      this.audit.log("warn", `challenge on ${url}: you declined to see it; the challenge stands`);
      return { ...first, handoffWhere: where, handoff: "declined" };
    };
    /** Open the same page once in a visible window and hand it to the person. */
    const escalate = async (asked: boolean): Promise<Rendered> => {
      this.audit.log("warn", `challenge on ${url}: opening it in a visible window for you to deal with`);
      let second: Rendered;
      try {
        this.escalation ??= this.makeEscalation();
        // session:true so what the person passes lands in the shared profile and the window need not
        // reappear; handoffApproved so the window does not ask a second time.
        second = await this.escalation.render(url, { ...opts, session: true, handoff: true, handoffApproved: true });
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
        if (!asked) {
          // Nobody could be asked first, so the window itself was the question and it went unanswered.
          this.awayUntil = Date.now() + AWAY_COOLDOWN_MS;
          this.audit.log(
            "warn",
            `the window went unanswered; not opening another for ${Math.round(AWAY_COOLDOWN_MS / 60_000)} min`,
          );
        }
        // Close the window rather than orphan it: a dead page must not sit there collecting a click
        // whose request has already given up.
        await this.escalation?.close().catch(() => {});
        this.escalation = null;
      }
      return second;
    };
    const answer = opts.handoffApproved
      ? "accept"
      : await askToSurface(
          this.handoffGate,
          { url, where },
          {
            resume: (a) => (a === "accept" ? escalate(true) : Promise.resolve(declined())),
            cancel: async () => {},
          },
        );
    if (typeof answer === "object") throw new HandoffPending(answer.deferred, url, where);
    if (answer === "declined") return declined();
    return escalate(answer === "accept");
  }

  async close(): Promise<void> {
    await this.routine.close();
    await this.escalation?.close().catch(() => {});
  }
}
