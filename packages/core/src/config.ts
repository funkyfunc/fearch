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
   * Which robots.txt groups apply. `default`/`strict` are the crawler posture (see fetch/robots.ts).
   * `off` is the user-agent posture: like a browser, robots.txt is not consulted; pace limits and
   * refusals still apply. Stamped on every result header. Engine result pages have their own rule:
   * with a person present (see `personPresent`) they are user-driven browsing, whatever this dial says.
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
   * `auto` (default): headless until a page shows a challenge — then the same page opens once in a
   * visible window for the person to deal with; where no window can be shown, the challenge stays
   * final. Prefers the person's own Chrome via the bridge extension whenever it is connected. The
   * other values pin one behaviour: `headless` — never show a window; `headed` — every render in the
   * visible installed Chrome; `extension` — the person's Chrome, headless fallback; `off` — no
   * browser tier.
   */
  browser: (typeof BROWSER_MODES)[number];
  /**
   * Whether a visible browser window could be shown to the person here (a display exists, and the
   * mode allows it). Derived, not an input: headed/extension assert it; auto detects it; headless/off
   * never surface anything.
   */
  canSurface: boolean;
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
   * When a page (or engine) shows a challenge, leave the tab in front and wait for the person to deal
   * with it, then continue with what they were shown. The tool never solves anything. On by default
   * whenever the browser is visible (headed or extension); FEARCH_HANDOFF=0 turns it off.
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
}

/**
 * A person is on call: any challenge the web shows will be surfaced in a visible window (or their own
 * Chrome) and only they can pass it — the tool is acting as their user agent, not as an unattended
 * crawler. Engine result pages are then their browsing, typed and read back for them; robots.txt
 * keeps governing what the tool fetches on its own.
 */
export function personPresent(s: Settings): boolean {
  return (s.browser === "auto" || s.browser === "headed" || s.browser === "extension") && s.handoff && s.canSurface;
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
export const ROBOTS_POLICIES = ["default", "strict", "off"] as const;
export const BROWSER_MODES = ["auto", "headless", "headed", "extension", "off"] as const;
export const SEARCH_MODES = ["all", "first-party", "off"] as const;

/** Could this machine show the person a browser window? macOS/Windows sessions can; elsewhere only with a display. */
function displayAvailable(env: Env, platform: string): boolean {
  return platform === "darwin" || platform === "win32" || !!(env.DISPLAY || env.WAYLAND_DISPLAY);
}

export function settingsFromEnv(env: Env = process.env, platform: string = process.platform): Settings {
  const cacheDir = env.FEARCH_CACHE_DIR?.trim() || join(homedir(), ".cache", "fearch");
  const robotsPolicy = pick(env.FEARCH_ROBOTS_POLICY, ROBOTS_POLICIES, "default");
  const browser = pick(env.FEARCH_BROWSER, BROWSER_MODES, "auto");
  const canSurface =
    browser === "headed" || browser === "extension"
      ? true
      : browser === "auto"
        ? displayAvailable(env, platform)
        : false;
  // Handoff defaults on wherever a window (or the person's Chrome) could carry a challenge to them.
  // FEARCH_HANDOFF=0 opts out — then nothing is ever surfaced and challenges are final.
  const handoff =
    browser === "auto" || browser === "headed" || browser === "extension"
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
    canSurface,
    browserIdentity: pick(env.FEARCH_BROWSER_IDENTITY, ["header", "none"] as const, "header"),
    handoff,
    incognito: browser === "extension" && envBool(env, "FEARCH_INCOGNITO"),
    extensionConnectMs: envInt(env, "FEARCH_EXTENSION_CONNECT_MS", 4_000),
    handoffTimeoutMs: envInt(env, "FEARCH_HANDOFF_TIMEOUT_MS", 180_000),
    browserSession: browser === "headed" && envBool(env, "FEARCH_BROWSER_SESSION"),
    // Derived default: DuckDuckGo (the robots-permitted engine); with a person on call to pass
    // Google's check when it appears, Google first. Bing is opt-in (it has served decoy results to
    // automated browsers).
    engines: (env.FEARCH_ENGINES === undefined
      ? canSurface && handoff
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
 *   --browser auto|headless|headed|extension|off  auto (default): headless until a challenge, which
 *                                            opens in a visible window for the person (extension
 *                                            preferred when connected; graceful with no display);
 *                                            or pin: never visible / always visible / extension / none
 *   --robots default|strict|off            consent dial for the tool's own fetching (default: default)
 *   --engines google,duckduckgo            search-engine order (default derived from --browser)
 *   --allow-domains a,b  --deny-domains c  host lists (subdomains included)
 *
 * That is the whole flag surface on purpose. Every other setting is an environment variable
 * (FEARCH_*) — escape hatches, not the interface. Flags map onto the same settings as the
 * environment variables and win over them. Returns the remaining argv (subcommands and their own
 * flags) alongside the settings.
 */
export const SERVER_FLAGS: Record<string, { env: string; boolean?: boolean }> = {
  robots: { env: "FEARCH_ROBOTS_POLICY" },
  browser: { env: "FEARCH_BROWSER" },
  engines: { env: "FEARCH_ENGINES" },
  "allow-domains": { env: "FEARCH_ALLOW_DOMAINS" },
  "deny-domains": { env: "FEARCH_DENY_DOMAINS" },
};

export function settingsFromArgs(
  argv: string[],
  env: Env = process.env,
  platform: string = process.platform,
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
  return { settings: settingsFromEnv({ ...env, ...overrides }, platform), rest, overrides };
}
