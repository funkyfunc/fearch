/** Wires the parts together. Everything downstream — the MCP server, the CLI, tests — starts here. */

import { EventEmitter } from "node:events";
import { Audit } from "./audit.js";
import { Cache } from "./cache.js";
import { settingsFromEnv, type Settings } from "./config.js";
import { BrowserRenderer, EscalatingRenderer, type BrowserTier, type HandoffGate } from "./fetch/browser.js";
import { ExtensionBridge, ExtensionRenderer, loadOrCreateExtensionToken } from "./fetch/extension.js";
import { PendingChecks } from "./fetch/pending.js";

/**
 * How long a page that hit a bot check waits in the background for the person's answer. Longer than
 * any prompt timeout on purpose: a suspended tab costs nothing, and a late "yes" should land on the
 * live page rather than on "fetch it again".
 */
const PENDING_CHECK_TTL_MS = 10 * 60_000;
import { Fetcher } from "./fetch/pipeline.js";
import { RobotsChecker } from "./fetch/robots.js";
import { Transport } from "./fetch/transport.js";
import { fetchedText } from "./fetch/types.js";
import { Politeness } from "./politeness.js";
import { engineProviders } from "./search/engines.js";
import { SearchRegistry } from "./search/registry.js";

/** In-process signals from the depths of a render to whoever is presenting fearch (the MCP server). */
export interface AppEvents extends EventEmitter {
  emit(event: "handoff", info: { url: string; where: string; message?: string }): boolean;
  emit(event: "handoff-end", info: { url: string; passed: boolean }): boolean;
  on(event: "handoff", fn: (info: { url: string; where: string; message?: string }) => void): this;
  on(event: "handoff-end", fn: (info: { url: string; passed: boolean }) => void): this;
}

export interface App {
  settings: Settings;
  events: AppEvents;
  /** How a bot check is put to the person before anything is surfaced; the MCP server installs the ask. */
  gate: HandoffGate;
  /** Renders suspended on a bot check, waiting for the person's answer on the next tool call. */
  pending: PendingChecks;
  audit: Audit;
  cache: Cache;
  transport: Transport;
  politeness: Politeness;
  robots: RobotsChecker;
  fetcher: Fetcher;
  search: SearchRegistry;
  browser: BrowserTier;
  close(): Promise<void>;
}

export function createApp(settings: Settings = settingsFromEnv()): App {
  const events = new EventEmitter() as AppEvents;
  const gate: HandoffGate = {};
  // A suspended check outlives the prompt's own timeout by a little, so a late "yes" still lands.
  const pending = new PendingChecks(PENDING_CHECK_TTL_MS);
  const audit = new Audit(settings);
  const cache = new Cache(settings.noCache ? null : `${settings.cacheDir}/cache-v2.sqlite`);
  const transport = new Transport(settings, audit);
  const politeness = new Politeness(settings.perHostDelayMs, settings.sessionBudget);

  const robots = new RobotsChecker(
    cache,
    async (url, { httpFallback }) => {
      // robots.txt has its own queue key: it is fetched once per host per hour and must not consume
      // the Crawl-delay gap that belongs between *page* requests. It may fall back to plain http
      // exactly when the page may (a bare host or http:// that was upgraded optimistically).
      const r = await politeness.run(`robots:${new URL(url).host}`, () =>
        transport.get(url, {
          source: "robots.txt",
          headers: { accept: "text/plain, */*;q=0.5" },
          maxBytes: 512 * 1024,
          httpFallback,
        }),
      );
      return { status: r.status, body: fetchedText(r) };
    },
    settings.robotsPolicy,
  );

  const browser = createBrowser(settings, audit, events, gate);
  const fetcher = new Fetcher(settings, cache, transport, robots, politeness, audit, browser);
  const engines = engineProviders(settings, browser, robots, politeness);
  const search = new SearchRegistry(settings, cache, audit, engines, browser);

  return {
    settings,
    events,
    gate,
    pending,
    audit,
    cache,
    transport,
    politeness,
    robots,
    fetcher,
    search,
    browser,
    async close() {
      await pending.close();
      await browser.close();
      cache.close();
    },
  };
}

function createBrowser(settings: Settings, audit: Audit, events: AppEvents, gate: HandoffGate): BrowserTier {
  switch (settings.browser) {
    case "headless":
    case "off":
      return new BrowserRenderer(settings, audit, events, gate);
    default: {
      // auto and extension: the person's own Chrome whenever the paired extension is connected, else
      // headless with challenge escalation (or plain headless where nothing can be surfaced). The two
      // modes differ only in how long the extension is waited for and how loudly its absence is noted.
      const bridge = new ExtensionBridge(audit, loadOrCreateExtensionToken(settings.cacheDir));
      return new ExtensionRenderer(settings, audit, bridge, adaptive(settings, audit, events, gate), events, gate);
    }
  }
}

/**
 * Headless-first page reads with a real window where one can be shown (a challenge escalates to it;
 * engine pages open in it as background tabs); plain headless where nothing can be shown.
 */
function adaptive(settings: Settings, audit: Audit, events: AppEvents, gate: HandoffGate): BrowserTier {
  const auto: Settings = { ...settings, browser: "auto" };
  return settings.canSurface
    ? new EscalatingRenderer(auto, audit, new BrowserRenderer(auto, audit, events, gate), undefined, events, gate)
    : new BrowserRenderer({ ...settings, browser: "headless" }, audit, events, gate);
}
