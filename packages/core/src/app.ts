/** Wires the parts together. Everything downstream — the MCP server, the CLI, tests — starts here. */

import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { Audit } from "./audit.js";
import { Cache } from "./cache.js";
import { settingsFromEnv, type Settings } from "./config.js";
import { BrowserRenderer, type BrowserTier } from "./fetch/browser.js";
import { ExtensionBridge, ExtensionRenderer } from "./fetch/extension.js";
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
  migrateLegacyProfile(settings);
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
  const search = new SearchRegistry(settings, cache, audit, fetcher.http("search", { budget: false }), engines);

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
  if (settings.browser !== "extension") return new BrowserRenderer(settings, audit);
  const fallback = new BrowserRenderer({ ...settings, browser: "headless" }, audit);
  return new ExtensionRenderer(settings, audit, new ExtensionBridge(audit), fallback);
}

/** One-time move of the browser profile from the pre-rename cache directory (websearch-mcp → fearch). */
function migrateLegacyProfile(settings: Settings): void {
  try {
    const legacy = settings.browserStatePath.replace(
      /([\\/])fearch([\\/])browser-state\.json$/,
      "$1websearch-mcp$2browser-state.json",
    );
    if (legacy !== settings.browserStatePath && !existsSync(settings.browserStatePath) && existsSync(legacy)) {
      mkdirSync(dirname(settings.browserStatePath), { recursive: true });
      copyFileSync(legacy, settings.browserStatePath);
    }
  } catch {
    // best effort
  }
}
