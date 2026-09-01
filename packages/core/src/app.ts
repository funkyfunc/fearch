/** Wires the parts together. Everything downstream — the MCP server, the CLI, tests — starts here. */

import { Audit } from "./audit.js";
import { Cache } from "./cache.js";
import { settingsFromEnv, type Settings } from "./config.js";
import { BrowserRenderer, EscalatingRenderer, type BrowserTier } from "./fetch/browser.js";
import { ExtensionBridge, ExtensionRenderer, loadOrCreateExtensionToken } from "./fetch/extension.js";
import { Fetcher } from "./fetch/pipeline.js";
import { RobotsChecker } from "./fetch/robots.js";
import { Transport } from "./fetch/transport.js";
import { fetchedText } from "./fetch/types.js";
import { Politeness } from "./politeness.js";
import { engineProviders } from "./search/engines.js";
import { SearchRegistry } from "./search/registry.js";

export interface App {
  settings: Settings;
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
  const audit = new Audit(settings);
  const cache = new Cache(settings.noCache ? null : `${settings.cacheDir}/cache-v2.sqlite`);
  const transport = new Transport(settings, audit);
  const politeness = new Politeness(settings.perHostDelayMs, settings.sessionBudget);

  const robots = new RobotsChecker(
    cache,
    async (url) => {
      // robots.txt has its own queue key: it is fetched once per host per hour and must not consume
      // the Crawl-delay gap that belongs between *page* requests.
      const r = await politeness.run(`robots:${new URL(url).host}`, () =>
        transport.get(url, {
          source: "robots.txt",
          headers: { accept: "text/plain, */*;q=0.5" },
          maxBytes: 512 * 1024,
        }),
      );
      return { status: r.status, body: fetchedText(r) };
    },
    settings.robotsPolicy,
  );

  const browser = createBrowser(settings, audit);
  const fetcher = new Fetcher(settings, cache, transport, robots, politeness, audit, browser);
  const engines = engineProviders(settings, browser, robots, politeness);
  const search = new SearchRegistry(settings, cache, audit, engines);

  return {
    settings,
    audit,
    cache,
    transport,
    politeness,
    robots,
    fetcher,
    search,
    browser,
    async close() {
      await browser.close();
      cache.close();
    },
  };
}

function createBrowser(settings: Settings, audit: Audit): BrowserTier {
  switch (settings.browser) {
    case "headless":
    case "headed":
    case "off":
      return new BrowserRenderer(settings, audit);
    default: {
      // auto and extension: the person's own Chrome whenever the paired extension is connected, else
      // headless with challenge escalation (or plain headless where nothing can be surfaced). The two
      // modes differ only in how long the extension is waited for and how loudly its absence is noted.
      const bridge = new ExtensionBridge(audit, loadOrCreateExtensionToken(settings.cacheDir));
      return new ExtensionRenderer(settings, audit, bridge, adaptive(settings, audit));
    }
  }
}

/** Headless-first with challenge escalation where a window can be shown; plain headless where not. */
function adaptive(settings: Settings, audit: Audit): BrowserTier {
  const auto: Settings = { ...settings, browser: "auto" };
  return settings.canSurface && settings.handoff
    ? new EscalatingRenderer(auto, audit, new BrowserRenderer(auto, audit))
    : new BrowserRenderer({ ...settings, browser: "headless" }, audit);
}
