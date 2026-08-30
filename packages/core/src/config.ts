/** Environment-driven settings. Everything is optional; defaults are the respectful ones. */

import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const pkg = require("../package.json") as { version: string; homepage?: string };

export const VERSION: string = pkg.version;
export const PRODUCT = "fearch";

export interface Settings {
  version: string;
  uaInfoUrl: string;
  uaContact: string;
  userAgent: string;
  maxChars: number;
  excerptChars: number;
  timeoutMs: number;
  maxBytes: number;
  maxRedirects: number;
  perHostDelayMs: number;
  sessionBudget: { count: number; windowMs: number };
  allowPrivate: boolean;
  /**
   * Which robots.txt groups apply. `default`/`strict`/`minimal` are the crawler posture (see
   * fetch/robots.ts). `off` is the user-agent posture: like a browser, robots.txt is not consulted;
   * pace limits and refusals still apply. Stamped on every result header.
   */
  robotsPolicy: (typeof ROBOTS_POLICIES)[number];
  allowDomains: string[];
  denyDomains: string[];
  cacheDir: string;
  noCache: boolean;
  auditLog: string; // "stderr" | "off" | file path
  /** Also append every log line (INFO/WARN/DEBUG and AUDIT) to this file — for sharing a debug run. */
  logFile: string;
  logLevel: "debug" | "info" | "warn" | "error";
  /**
   * `headless` (default): bundled Chromium, new-headless. `headed`: the Chrome already installed on the
   * machine (falls back to bundled Chromium), in a visible window with a tool-owned profile that
   * persists across runs — the "user agent" posture, where the person can see what is opened and step
   * in on a challenge (see `handoff`). `extension`: the person's own Chrome via the fearch bridge
   * extension — no automation signals at all (falls back to headless if the extension isn't there).
   * `off`: no browser tier.
   */
  browser: (typeof BROWSER_MODES)[number];
  /** Extension only: open pages in an incognito window (no cookies from the person's profile). */
  incognito: boolean;
  /** Extension only: how long to wait for the extension to show up before falling back (ms). */
  extensionConnectMs: number;
  /**
   * How the browser tier identifies itself. `header` (default): stock Chrome User-Agent plus `From:`
   * (RFC 9110 §10.1.2, the header defined for robots to name their controller) and `X-Agent:` on every
   * request. `none`: plain Chrome, no identifying headers (user-agent posture). `navigator.webdriver` is
   * never touched. (Appending the token to the UA itself was measured to trip bot-checks and was dropped.)
   */
  browserIdentity: "header" | "none";
  /**
   * Headed only. When a page (or engine) shows a challenge, leave the tab in front and wait for the
   * person to deal with it, then continue with what they were shown. The tool never solves anything.
   */
  handoff: boolean;
  handoffTimeoutMs: number;
  /**
   * Headed only. Whether cookies the person created in the tool's own browser profile (by logging in
   * or clicking through something in that window) are sent when reading ordinary pages. Engine result
   * pages always use the profile (that is where a passed challenge lives). Results read with the
   * person's session are labelled.
   */
  browserSession: boolean;
  /**
   * Search-engine result pages the browser may open, in preference order. Only engines whose
   * robots.txt permits their result pages are eligible unless `robotsPolicy` is `off`.
   */
  engines: string[];
  /** Where the headed profile's cookies/storage are persisted. */
  browserStatePath: string;
  browserTimeoutMs: number;
  browserMaxConcurrent: number;
  /** all: third-party services + first-party APIs; first-party: only the sites' own APIs; off: no search tool activity. */
  searchMode: (typeof SEARCH_MODES)[number];
  /** Minimum gap between requests to specific hosts (ms), e.g. arXiv asks for 3 s. */
  hostGapsMs: Record<string, number>;
  /** Exa's keyless hosted search, as the fallback after the engines. Empty = off (the default: queries stay off third-party services). */
  exaHostedUrl: string;
}

type Env = Record<string, string | undefined>;

const envBool = (env: Env, name: string, def = false): boolean => {
  const v = env[name];
  return v === undefined || v === "" ? def : ["1", "true", "yes", "on"].includes(v.trim().toLowerCase());
};
const envInt = (env: Env, name: string, def: number): number => {
  const v = Number(env[name]);
  return Number.isFinite(v) && v > 0 ? v : def;
};
const envList = (env: Env, name: string): string[] =>
  (env[name] ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);

/**
 * Format mirrors documented agents (Googlebot, Bingbot, Claude-User): product/version (+info-url).
 * The URL is what operators need — it names the robots.txt token and explains the agent. A contact
 * is optional; most organisations won't set one and that is fine.
 */
export function userAgentFor(infoUrl: string, contact = ""): string {
  const parts = [`+${infoUrl}`];
  if (contact) parts.push(contact);
  return `${PRODUCT}/${VERSION} (${parts.join("; ")})`;
}

const pick = <T extends string>(raw: string | undefined, allowed: readonly T[], def: T): T => {
  const v = raw?.trim().toLowerCase() as T | undefined;
  return v && allowed.includes(v) ? v : def;
};

export const KNOWN_ENGINES = ["duckduckgo", "bing", "google"] as const;
export const ROBOTS_POLICIES = ["default", "strict", "minimal", "off"] as const;
export const BROWSER_MODES = ["headless", "headed", "extension", "off"] as const;
export const SEARCH_MODES = ["all", "first-party", "off"] as const;

export function settingsFromEnv(env: Env = process.env): Settings {
  const cacheDir = env.FEARCH_CACHE_DIR?.trim() || join(homedir(), ".cache", "fearch");
  const robotsPolicy = pick(env.FEARCH_ROBOTS_POLICY, ROBOTS_POLICIES, "default");
  const browser = pick(env.FEARCH_BROWSER, BROWSER_MODES, "headless");
  // Handoff needs a person-visible browser. In the extension it is the person's own Chrome, so it defaults on.
  const handoff =
    browser === "headed"
      ? envBool(env, "FEARCH_HANDOFF")
      : browser === "extension"
        ? envBool(env, "FEARCH_HANDOFF", true)
        : false;
  const infoUrl = env.FEARCH_UA_INFO_URL?.trim() || pkg.homepage || "https://github.com/funkyfunc/fearch";
  const contact = env.FEARCH_UA_CONTACT?.trim() || "";
  return {
    version: VERSION,
    uaInfoUrl: infoUrl,
    uaContact: contact,
    userAgent: userAgentFor(infoUrl, contact),
    maxChars: envInt(env, "FEARCH_MAX_CHARS", 12_000),
    excerptChars: envInt(env, "FEARCH_EXCERPT_CHARS", 1_500),
    timeoutMs: envInt(env, "FEARCH_TIMEOUT_MS", 30_000),
    maxBytes: envInt(env, "FEARCH_MAX_BYTES", 10 * 1024 * 1024),
    maxRedirects: 6,
    perHostDelayMs: envInt(env, "FEARCH_PER_HOST_DELAY_MS", 1_000),
    sessionBudget: {
      count: envInt(env, "FEARCH_BUDGET_COUNT", 60),
      windowMs: envInt(env, "FEARCH_BUDGET_WINDOW_MS", 10 * 60_000),
    },
    allowPrivate: envBool(env, "FEARCH_ALLOW_PRIVATE"),
    robotsPolicy,
    allowDomains: envList(env, "FEARCH_ALLOW_DOMAINS"),
    denyDomains: envList(env, "FEARCH_DENY_DOMAINS"),
    cacheDir,
    noCache: envBool(env, "FEARCH_NO_CACHE"),
    auditLog: env.FEARCH_AUDIT_LOG?.trim() || "stderr",
    logFile: env.FEARCH_LOG_FILE?.trim() || "",
    logLevel: (env.FEARCH_LOG_LEVEL?.toLowerCase() as Settings["logLevel"]) || "info",
    browser,
    browserIdentity: pick(env.FEARCH_BROWSER_IDENTITY, ["header", "none"] as const, "header"),
    handoff,
    incognito: browser === "extension" && envBool(env, "FEARCH_INCOGNITO"),
    extensionConnectMs: envInt(env, "FEARCH_EXTENSION_CONNECT_MS", 4_000),
    handoffTimeoutMs: envInt(env, "FEARCH_HANDOFF_TIMEOUT_MS", 180_000),
    browserSession: browser === "headed" && envBool(env, "FEARCH_BROWSER_SESSION"),
    // Derived default: DuckDuckGo (the robots-permitted engine); with robots off *and* a person to pass
    // Google's check, Google first. Bing is opt-in (it has served decoy results to automated browsers).
    engines: (env.FEARCH_ENGINES === undefined
      ? robotsPolicy === "off" && handoff
        ? ["google", "duckduckgo"]
        : ["duckduckgo"]
      : envList(env, "FEARCH_ENGINES")
    ).filter((e) => (KNOWN_ENGINES as readonly string[]).includes(e)),
    browserStatePath: join(cacheDir, "browser-state.json"),
    browserTimeoutMs: envInt(env, "FEARCH_BROWSER_TIMEOUT_MS", 20_000),
    browserMaxConcurrent: envInt(env, "FEARCH_BROWSER_MAX_CONCURRENT", 2),
    searchMode: pick(env.FEARCH_SEARCH_MODE, SEARCH_MODES, "all"),
    hostGapsMs: {
      "export.arxiv.org": 3000,
      "arxiv.org": 3000,
      "api.semanticscholar.org": 3000,
      "api2.marginalia-search.com": 4000,
    },
    // Off unless asked for (--exa): a third-party service that logs queries is not a sensible corporate default.
    exaHostedUrl: envBool(env, "FEARCH_EXA") ? env.FEARCH_EXA_HOSTED_URL?.trim() || "https://mcp.exa.ai/mcp" : "",
  };
}

/** Domain list matching: exact host or any subdomain. */
export function domainMatches(host: string, list: string[]): boolean {
  const h = host.toLowerCase();
  return list.some((d) => h === d || h.endsWith("." + d));
}

/**
 * Command-line flags — the intended way to configure the server from an MCP config's `args`:
 *
 *   --robots default|strict|minimal|off   consent dial (default: default)
 *   --browser headless|headed|extension|off  bundled headless Chromium, your installed Chrome, your own Chrome via the extension, or none
 *   --incognito                            extension only: open pages in an incognito window
 *   --handoff                              hand challenges to the person (implies --browser headed)
 *   --engines google,duckduckgo            search-engine order (default derived from the two above)
 *   --exa                                  add Exa's keyless hosted search as the fallback after the engines
 *   --session                              send cookies from the tool profile to ordinary pages (headed)
 *   --identity header|none                 how the browser names the tool (default: header)
 *
 * Flags map onto the same settings as the environment variables and win over them. Returns the
 * remaining argv (subcommands and their own flags) alongside the settings.
 */
export const SERVER_FLAGS: Record<string, { env: string; boolean?: boolean }> = {
  robots: { env: "FEARCH_ROBOTS_POLICY" },
  browser: { env: "FEARCH_BROWSER" },
  handoff: { env: "FEARCH_HANDOFF", boolean: true },
  engines: { env: "FEARCH_ENGINES" },
  exa: { env: "FEARCH_EXA", boolean: true },
  incognito: { env: "FEARCH_INCOGNITO", boolean: true },
  session: { env: "FEARCH_BROWSER_SESSION", boolean: true },
  identity: { env: "FEARCH_BROWSER_IDENTITY" },
  "allow-domains": { env: "FEARCH_ALLOW_DOMAINS" },
  "deny-domains": { env: "FEARCH_DENY_DOMAINS" },
  "audit-log": { env: "FEARCH_AUDIT_LOG" },
  "log-file": { env: "FEARCH_LOG_FILE" },
  "log-level": { env: "FEARCH_LOG_LEVEL" },
  "cache-dir": { env: "FEARCH_CACHE_DIR" },
  "search-mode": { env: "FEARCH_SEARCH_MODE" },
};

export function settingsFromArgs(
  argv: string[],
  env: Env = process.env,
): { settings: Settings; rest: string[]; overrides: Record<string, string> } {
  const overrides: Record<string, string> = {};
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const m = /^--([a-z-]+)(?:=(.*))?$/.exec(a);
    const spec = m ? SERVER_FLAGS[m[1]] : undefined;
    if (!m || !spec) {
      rest.push(a);
      continue;
    }
    if (spec.boolean) {
      overrides[spec.env] = m[2] === undefined ? "1" : m[2];
    } else {
      const v = m[2] ?? argv[++i];
      if (v === undefined) throw new Error(`--${m[1]} needs a value`);
      overrides[spec.env] = v;
    }
  }
  if (envBool(overrides, "FEARCH_HANDOFF") && !overrides.FEARCH_BROWSER) overrides.FEARCH_BROWSER = "headed";
  return { settings: settingsFromEnv({ ...env, ...overrides }), rest, overrides };
}
