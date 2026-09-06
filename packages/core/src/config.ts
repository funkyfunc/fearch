/** Environment-driven settings. Everything is optional; defaults are the respectful ones. */

import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);
const pkg = require("../package.json") as { version: string; homepage?: string };

/**
 * This package's root on disk (the directory holding package.json), found from this module rather
 * than from any file's depth — so it is right whether the code ran from `src`, the per-file dev
 * build, or the single bundled file, which all sit one level below package.json.
 */
export const PACKAGE_DIR: string = dirname(require.resolve("../package.json"));

export const VERSION: string = pkg.version;
export const PRODUCT = "fearch";

export interface Settings {
  version: string;
  uaInfoUrl: string;
  uaContact: string;
  userAgent: string;
  maxChars: number;
  timeoutMs: number;
  maxRedirects: number;
  perHostDelayMs: number;
  sessionBudget: { count: number; windowMs: number };
  allowPrivate: boolean;
  /**
   * Which robots.txt groups apply (see fetch/robots.ts): `default` honours `*`, our token and the
   * user-initiated agent tokens; `strict` adds the training-crawler tokens. robots.txt is always
   * consulted for the tool's own fetching. Engine result pages have their own rule: with a person
   * present (see `personPresent`) they are that person's browsing.
   */
  robotsPolicy: (typeof ROBOTS_POLICIES)[number];
  allowDomains: string[];
  denyDomains: string[];
  cacheDir: string;
  noCache: boolean;
  auditLog: string; // "stderr" | "off" | file path
  logLevel: (typeof LOG_LEVELS)[number];
  /**
   * `auto` (default): headless until a page shows a challenge — then the same page opens once in a
   * visible window for the person to deal with; where no window can be shown, the challenge stays
   * final. Prefers the person's own Chrome via the bridge extension whenever it is connected. The
   * other values pin one behaviour: `headless` — never show a window; `extension` — the person's
   * Chrome, headless fallback; `off` — no browser tier.
   */
  browser: (typeof BROWSER_MODES)[number];
  /**
   * Whether a visible browser window could be shown to the person here (a display exists, and the
   * mode allows it). Derived, not an input: extension asserts it; auto detects it; headless/off
   * never surface anything.
   */
  canSurface: boolean;
  /** Extension (also as auto's preferred tier): open pages in an incognito window, not the person's profile. */
  incognito: boolean;
  /**
   * Google queries are always shown to the person in their MCP client (query, engine, profile) and
   * run only when accepted; where nobody can be asked that way, the search box is handed over in the
   * browser and they press Enter. `--human-search` extends the form to every query, DuckDuckGo lite
   * (robots-permitted, otherwise automatic) included.
   */
  humanSearch: boolean;
  /** Extension only: how long to wait for the extension to show up before falling back (ms). */
  extensionConnectMs: number;
  /**
   * When a page (or engine) shows a challenge, leave the tab in front and wait for the person to deal
   * with it, then continue with what they were shown. The tool never solves anything. On by default
   * whenever the browser is visible (headed or extension); --no-handoff turns it off.
   */
  handoff: boolean;
  /** How long a prompt to the person waits for an answer (and a page handed over without a prompt, for them to press Enter). */
  handoffTimeoutMs: number;
  /** How long a bot check the person agreed to open waits for them to pass it: a yes means they are there. */
  challengeTimeoutMs: number;
  /**
   * Search-engine result pages the browser may open, in preference order. Only engines whose
   * robots.txt permits their result pages are eligible unless `robotsPolicy` is `off`.
   */
  engines: string[];
  /** Where the tool-owned Chrome profile (engine window, escalation window) is persisted. */
  browserStatePath: string;
  browserTimeoutMs: number;
  browserMaxConcurrent: number;
  /** all: the configured engines; off: no search tool activity at all. */
  searchMode: (typeof SEARCH_MODES)[number];
  /**
   * BCP-47 tag ("de-DE", "en-US", bare "fr") derived from the machine's environment — the honest
   * locale, never an invented persona. Engines receive it as their own language/region parameters;
   * Accept-Language reflects it. FEARCH_LOCALE overrides; default en-US.
   */
  locale: string;
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
  return (s.browser === "auto" || s.browser === "extension") && s.handoff && s.canSurface;
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

export const KNOWN_ENGINES = ["duckduckgo", "google"] as const;
export const ROBOTS_POLICIES = ["default", "strict"] as const;
export const BROWSER_MODES = ["auto", "headless", "extension", "off"] as const;
export const SEARCH_MODES = ["all", "off"] as const;
export const LOG_LEVELS = ["debug", "info", "warn", "error"] as const;

/** The machine's locale from the environment (FEARCH_LOCALE wins), normalised to lang or lang-REGION. */
function localeFrom(env: Env): string {
  const raw = (env.FEARCH_LOCALE || env.LC_ALL || env.LC_MESSAGES || env.LANG || env.LANGUAGE || "").trim();
  const m = /^([a-zA-Z]{2,3})(?:[_-]([a-zA-Z]{2}))?/.exec(raw);
  if (!m || /^(c|posix)$/i.test(m[1])) return "en-US";
  return m[2] ? `${m[1].toLowerCase()}-${m[2].toUpperCase()}` : m[1].toLowerCase();
}

export function localeParts(locale: string): { lang: string; region: string } {
  const [lang, region] = locale.split("-");
  return { lang, region: region ?? "" };
}

/** Accept-Language for the machine's locale, with an honest English fallback for non-English locales. */
export function acceptLanguage(locale: string): string {
  const { lang } = localeParts(locale);
  return lang === "en" ? `${locale},en;q=0.8` : `${locale},${lang};q=0.9,en;q=0.5`;
}

/** Could this machine show the person a browser window? macOS/Windows sessions can; elsewhere only with a display. */
function displayAvailable(env: Env, platform: string): boolean {
  return platform === "darwin" || platform === "win32" || !!(env.DISPLAY || env.WAYLAND_DISPLAY);
}

export function settingsFromEnv(env: Env = process.env, platform: string = process.platform): Settings {
  const cacheDir = env.FEARCH_CACHE_DIR?.trim() || join(homedir(), ".cache", "fearch");
  const robotsPolicy = pick(env.FEARCH_ROBOTS_POLICY, ROBOTS_POLICIES, "default");
  const browser = pick(env.FEARCH_BROWSER, BROWSER_MODES, "auto");
  const canSurface = browser === "extension" ? true : browser === "auto" ? displayAvailable(env, platform) : false;
  // Handoff defaults on wherever a window (or the person's Chrome) could carry a challenge to them.
  // --no-handoff opts out — then nothing is ever surfaced and challenges are final.
  const handoff = browser === "auto" || browser === "extension" ? envBool(env, "FEARCH_HANDOFF", true) : false;
  const infoUrl = env.FEARCH_UA_INFO_URL?.trim() || pkg.homepage || "https://github.com/funkyfunc/fearch";
  const contact = env.FEARCH_UA_CONTACT?.trim() || "";
  return {
    version: VERSION,
    uaInfoUrl: infoUrl,
    uaContact: contact,
    userAgent: userAgentFor(infoUrl, contact),
    maxChars: envInt(env, "FEARCH_MAX_CHARS", 12_000),
    timeoutMs: envInt(env, "FEARCH_TIMEOUT_MS", 30_000),
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
    logLevel: pick(env.FEARCH_LOG_LEVEL, LOG_LEVELS, "info"),
    browser,
    canSurface,
    handoff,
    incognito: (browser === "extension" || browser === "auto") && envBool(env, "FEARCH_INCOGNITO"),
    humanSearch: envBool(env, "FEARCH_HUMAN_SEARCH"),
    extensionConnectMs: envInt(env, "FEARCH_EXTENSION_CONNECT_MS", 4_000),
    // Long enough for a person at the screen to pass a check, short enough that an unattended agent
    // gets its answer ("waiting for you; call again") instead of a hung tool call.
    handoffTimeoutMs: envInt(env, "FEARCH_HANDOFF_TIMEOUT_MS", 45_000),
    // Starts at the yes: the person is there, so a slow check gets time without a hung call.
    challengeTimeoutMs: envInt(env, "FEARCH_CHALLENGE_TIMEOUT_MS", 90_000),
    // Default: DuckDuckGo lite, the one engine whose robots.txt permits its result pages. Google is
    // opt-in (`--engines google,duckduckgo`) and needs a person on call to pass its checks.
    engines: (env.FEARCH_ENGINES === undefined ? ["duckduckgo"] : envList(env, "FEARCH_ENGINES")).filter((e) =>
      (KNOWN_ENGINES as readonly string[]).includes(e),
    ),
    browserStatePath: join(cacheDir, "browser-state.json"),
    browserTimeoutMs: envInt(env, "FEARCH_BROWSER_TIMEOUT_MS", 20_000),
    browserMaxConcurrent: envInt(env, "FEARCH_BROWSER_MAX_CONCURRENT", 2),
    searchMode: pick(env.FEARCH_SEARCH_MODE, SEARCH_MODES, "all"),
    locale: localeFrom(env),
    hostGapsMs: {
      "export.arxiv.org": 3000,
      "arxiv.org": 3000,
    },
  };
}

/** Domain list matching: exact host or any subdomain. */
export function domainMatches(host: string, list: string[]): boolean {
  const h = host.toLowerCase();
  return list.some((d) => h === d || h.endsWith("." + d));
}

/**
 * One settings table, every setting a flag. `--engines google` in an MCP config's `args` and
 * `FEARCH_ENGINES=google` in its `env` are the same setting (flags win); the help text, the parser
 * and the docs all come from this table, so there is no second category of "hidden" knobs. Booleans
 * take `--incognito`, `--incognito=false` or `--no-incognito`. The tuning entries are real settings
 * nobody should need; they are listed compactly at the end of `--help`.
 */
export interface FlagSpec {
  flag: string;
  env: string;
  kind: "enum" | "bool" | "int" | "string" | "list";
  values?: readonly string[];
  /** Shown in help; the code's own default lives in settingsFromEnv. */
  default: string;
  help: string;
  tuning?: boolean;
}

export const FLAGS: readonly FlagSpec[] = [
  {
    flag: "browser",
    env: "FEARCH_BROWSER",
    kind: "enum",
    values: BROWSER_MODES,
    default: "auto",
    help: "auto: pages read headless; a site's challenge, and every engine result page, opens in your own Chrome via the bridge extension when it is connected, else in a background window of your installed Chrome — opened once when Chrome starts, kept off to the side, brought forward when a check needs you (no display: no engine search, challenges final). Or pin one: headless (never a window, no engine search) · extension (your Chrome only) · off.",
  },
  {
    flag: "robots",
    env: "FEARCH_ROBOTS_POLICY",
    kind: "enum",
    values: ROBOTS_POLICIES,
    default: "default",
    help: "robots.txt for the tool's own fetching: honour user-initiated agent opt-outs (default), or also honour training-crawler opt-outs (strict).",
  },
  {
    flag: "engines",
    env: "FEARCH_ENGINES",
    kind: "list",
    values: KNOWN_ENGINES,
    default: "duckduckgo",
    help: "Engine result pages in preference order. DuckDuckGo lite is the one engine whose robots.txt permits it and runs without asking; every google query is shown to you first (query, engine, profile) and runs as your own browsing.",
  },
  {
    flag: "human-search",
    env: "FEARCH_HUMAN_SEARCH",
    kind: "bool",
    default: "false",
    help: "Show every query to you in your MCP client before it runs — the query to edit, a Google/DuckDuckGo checkbox and incognito or not — not only Google queries, which always are (in the CLI: the search box is handed over in your browser and you press Enter).",
  },
  {
    flag: "incognito",
    env: "FEARCH_INCOGNITO",
    kind: "bool",
    default: "false",
    help: "Your own Chrome (extension, or auto when it is connected): open pages and engine result pages in an incognito window, not your profile.",
  },
  {
    flag: "handoff",
    env: "FEARCH_HANDOFF",
    kind: "bool",
    default: "true",
    help: "Hand a bot check to you in a visible window/tab and wait for you to pass it. --no-handoff: never surface anything; challenges are final.",
  },
  {
    flag: "allow-domains",
    env: "FEARCH_ALLOW_DOMAINS",
    kind: "list",
    default: "",
    help: "Only fetch these hosts (subdomains included).",
  },
  {
    flag: "deny-domains",
    env: "FEARCH_DENY_DOMAINS",
    kind: "list",
    default: "",
    help: "Never fetch these hosts (subdomains included).",
  },
  {
    flag: "search",
    env: "FEARCH_SEARCH_MODE",
    kind: "enum",
    values: SEARCH_MODES,
    default: "all",
    help: "off: no search tool activity at all (fetch only).",
  },
  {
    flag: "max-chars",
    env: "FEARCH_MAX_CHARS",
    kind: "int",
    default: "12000",
    help: "Default character budget of a fetch result.",
  },
  {
    flag: "locale",
    env: "FEARCH_LOCALE",
    kind: "string",
    default: "from LANG",
    help: "BCP-47 tag engines and Accept-Language speak (de-DE, fr, …). Defaults to the machine's locale.",
  },
  {
    flag: "cache-dir",
    env: "FEARCH_CACHE_DIR",
    kind: "string",
    default: "~/.cache/fearch",
    help: "Where the page/robots cache, browser profile and pairing token live.",
  },
  {
    flag: "no-cache",
    env: "FEARCH_NO_CACHE",
    kind: "bool",
    default: "false",
    help: "Never read or write the page cache.",
  },
  {
    flag: "audit-log",
    env: "FEARCH_AUDIT_LOG",
    kind: "string",
    default: "stderr (server) · off (commands)",
    help: "One JSON line per network request: stderr, off, or a file path.",
  },
  {
    flag: "log-level",
    env: "FEARCH_LOG_LEVEL",
    kind: "enum",
    values: LOG_LEVELS,
    default: "info (server) · warn (commands)",
    help: "Log verbosity on stderr. debug also saves engine pages that failed to parse (account details redacted).",
  },
  {
    flag: "ua-info-url",
    env: "FEARCH_UA_INFO_URL",
    kind: "string",
    default: "the project's bot-info page",
    help: "URL in the User-Agent — point it at your organisation's own bot page.",
  },
  {
    flag: "ua-contact",
    env: "FEARCH_UA_CONTACT",
    kind: "string",
    default: "",
    help: "Contact appended to the User-Agent (optional).",
  },
  // ---- tuning: real settings nobody should need
  {
    flag: "allow-private",
    env: "FEARCH_ALLOW_PRIVATE",
    kind: "bool",
    default: "false",
    help: "Allow private/loopback targets (development only).",
    tuning: true,
  },
  {
    flag: "budget",
    env: "FEARCH_BUDGET_COUNT",
    kind: "int",
    default: "60",
    help: "Page fetches per budget window.",
    tuning: true,
  },
  {
    flag: "budget-window-ms",
    env: "FEARCH_BUDGET_WINDOW_MS",
    kind: "int",
    default: "600000",
    help: "Budget window.",
    tuning: true,
  },
  {
    flag: "timeout-ms",
    env: "FEARCH_TIMEOUT_MS",
    kind: "int",
    default: "30000",
    help: "Plain HTTP request timeout.",
    tuning: true,
  },
  {
    flag: "browser-timeout-ms",
    env: "FEARCH_BROWSER_TIMEOUT_MS",
    kind: "int",
    default: "20000",
    help: "Browser navigation timeout.",
    tuning: true,
  },
  {
    flag: "handoff-timeout-ms",
    env: "FEARCH_HANDOFF_TIMEOUT_MS",
    kind: "int",
    default: "45000",
    help: "How long a prompt to you waits for an answer before the tool says nobody answered (also the wait for you to press Enter when a search box is handed over without a prompt).",
    tuning: true,
  },
  {
    flag: "challenge-timeout-ms",
    env: "FEARCH_CHALLENGE_TIMEOUT_MS",
    kind: "int",
    default: "90000",
    help: "How long a bot check you said yes to waits for you to pass it, counted from the yes.",
    tuning: true,
  },
  {
    flag: "per-host-delay-ms",
    env: "FEARCH_PER_HOST_DELAY_MS",
    kind: "int",
    default: "1000",
    help: "Minimum gap between requests to one host (Crawl-delay if larger).",
    tuning: true,
  },
  {
    flag: "extension-connect-ms",
    env: "FEARCH_EXTENSION_CONNECT_MS",
    kind: "int",
    default: "4000",
    help: "How long to wait for the bridge extension before falling back.",
    tuning: true,
  },
  {
    flag: "browser-max-concurrent",
    env: "FEARCH_BROWSER_MAX_CONCURRENT",
    kind: "int",
    default: "2",
    help: "Concurrent browser renders.",
    tuning: true,
  },
];

const BY_FLAG = new Map(FLAGS.map((f) => [f.flag, f]));

/** A flag or value the person got wrong: one line and the exit code, never a stack trace. */
export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

const BOOL_WORDS = /^(1|0|true|false|yes|no|on|off)$/i;

/** Validate one flag's value against its spec; the parsed value is what settingsFromEnv reads. */
function checkValue(spec: FlagSpec, flag: string, v: string): void {
  const value = v.trim().toLowerCase();
  if (spec.kind === "enum" && spec.values && !spec.values.includes(value)) {
    if (flag === "browser" && value === "headed")
      throw new UsageError(
        "--browser headed was removed: auto already reads pages headless and opens your installed Chrome (or your own, via the extension) for engine pages and bot checks",
      );
    throw new UsageError(`--${flag} must be one of ${spec.values.join("|")}, not "${v}"`);
  }
  if (spec.kind === "list" && spec.values) {
    const known = spec.values as readonly string[];
    const bad = value
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s && !known.includes(s));
    if (bad.length) throw new UsageError(`--${flag}: unknown ${bad.join(", ")} (known: ${known.join(", ")})`);
  }
  if (spec.kind === "int" && !/^\d+$/.test(value)) throw new UsageError(`--${flag} needs a whole number, not "${v}"`);
  if (spec.kind === "bool" && !BOOL_WORDS.test(value))
    throw new UsageError(`--${flag} takes true or false, not "${v}"`);
}

/**
 * Parse server flags out of argv (anything else — subcommands and their own flags — is returned as
 * `rest`), apply them over the environment, and build the settings. `overrides` are the env-spelled
 * values the flags produced, for logging.
 */
export function settingsFromArgs(
  argv: string[],
  env: Env = process.env,
  platform: string = process.platform,
): { settings: Settings; rest: string[]; overrides: Record<string, string> } {
  const overrides: Record<string, string> = {};
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const m = /^--(no-)?([a-z][a-z0-9-]*)(?:=(.*))?$/.exec(a);
    if (!m) {
      rest.push(a);
      continue;
    }
    // `--no-cache` is a flag in its own right; `--no-handoff` negates `--handoff`.
    let spec = BY_FLAG.get(m[1] ? `no-${m[2]}` : m[2]);
    let negated = false;
    if (!spec && m[1]) {
      spec = BY_FLAG.get(m[2]);
      negated = !!spec;
    }
    if (!spec) {
      rest.push(a);
      continue;
    }
    if (spec.kind === "bool") {
      const explicit = m[3];
      if (explicit !== undefined) checkValue(spec, m[2], explicit);
      overrides[spec.env] = negated ? "0" : explicit === undefined ? "1" : explicit;
      continue;
    }
    if (negated) throw new UsageError(`--no-${m[2]} is not a boolean flag`);
    const v = m[3] ?? argv[++i];
    if (v === undefined) throw new UsageError(`--${m[2]} needs a value`);
    checkValue(spec, m[2], v);
    overrides[spec.env] = v;
  }
  return { settings: settingsFromEnv({ ...env, ...overrides }, platform), rest, overrides };
}

/** `--flag value` spelling of an env-spelled override, for logs. */
export function flagSpelling(envName: string, value: string): string {
  const f = FLAGS.find((x) => x.env === envName);
  if (!f) return `${envName}=${value}`;
  if (f.kind === "bool")
    return ["1", "true", "yes", "on"].includes(value.toLowerCase()) ? `--${f.flag}` : `--no-${f.flag}`;
  return `--${f.flag} ${value}`;
}
