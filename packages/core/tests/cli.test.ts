import { describe, expect, it } from "vitest";
import { parseArgs } from "../src/cli/args.js";
import { FLAGS, settingsFromArgs, settingsFromEnv, UsageError } from "../src/config.js";

const env = { FEARCH_AUDIT_LOG: "off" } as Record<string, string>;
const parse = (argv: string[]) => settingsFromArgs(argv, env, "linux");

describe("server flags", () => {
  it("validates every kind of value, not only enums", () => {
    expect(() => parse(["--robots", "off"])).toThrow(UsageError);
    expect(() => parse(["--robots", "off"])).toThrow(/must be one of default\|strict/);
    expect(() => parse(["--engines", "bing"])).toThrow(/unknown bing \(known: duckduckgo, google\)/);
    expect(() => parse(["--engines", "google,bing,yahoo"])).toThrow(/unknown bing, yahoo/);
    expect(() => parse(["--max-chars", "abc"])).toThrow(/whole number/);
    expect(() => parse(["--human-search=maybe"])).toThrow(/true or false/);
    expect(() => parse(["--no-max-chars"])).toThrow(/not a boolean flag/);
    expect(() => parse(["--engines"])).toThrow(/needs a value/);
  });

  it("accepts the documented spellings", () => {
    expect(parse(["--engines", "google,duckduckgo"]).settings.engines).toEqual(["google", "duckduckgo"]);
    expect(parse(["--human-search=false"]).settings.humanSearch).toBe(false);
    expect(parse(["--no-handoff"]).settings.handoff).toBe(false);
    expect(parse(["--max-chars=500"]).settings.maxChars).toBe(500);
    expect(parse(["--browser", "HEADLESS"]).settings.browser).toBe("headless");
    // an unknown flag is left for the command layer, which reports it
    expect(parse(["--engine", "google"]).rest).toEqual(["--engine", "google"]);
  });
});

describe("command flags", () => {
  it("understands --flag value, --flag=value and bare --flag", () => {
    expect(parseArgs(["u", "--max-chars=500", "--mode", "focus", "--links"])).toEqual({
      positional: ["u"],
      flags: { "max-chars": "500", mode: "focus", links: true },
    });
  });
});

describe("flag table", () => {
  it("shows the same defaults the code applies (one source of truth, checked)", () => {
    const s = settingsFromEnv({} as Record<string, string>, "linux");
    const byEnv: Record<string, unknown> = {
      FEARCH_BROWSER: s.browser,
      FEARCH_ROBOTS_POLICY: s.robotsPolicy,
      FEARCH_ENGINES: s.engines.join(","),
      FEARCH_HUMAN_SEARCH: s.humanSearch,
      FEARCH_INCOGNITO: s.incognito,
      FEARCH_HANDOFF: s.handoff,
      FEARCH_SEARCH_MODE: s.searchMode,
      FEARCH_MAX_CHARS: s.maxChars,
      FEARCH_ALLOW_PRIVATE: s.allowPrivate,
      FEARCH_BUDGET_COUNT: s.sessionBudget.count,
      FEARCH_BUDGET_WINDOW_MS: s.sessionBudget.windowMs,
      FEARCH_TIMEOUT_MS: s.timeoutMs,
      FEARCH_BROWSER_TIMEOUT_MS: s.browserTimeoutMs,
      FEARCH_HANDOFF_TIMEOUT_MS: s.handoffTimeoutMs,
      FEARCH_CHALLENGE_TIMEOUT_MS: s.challengeTimeoutMs,
      FEARCH_PER_HOST_DELAY_MS: s.perHostDelayMs,
      FEARCH_EXTENSION_CONNECT_MS: s.extensionConnectMs,
      FEARCH_BROWSER_MAX_CONCURRENT: s.browserMaxConcurrent,
    };
    for (const f of FLAGS) {
      if (!(f.env in byEnv)) continue; // prose defaults ("from LANG", "the project's bot-info page") are not checked
      expect({ flag: f.flag, default: f.default }).toEqual({ flag: f.flag, default: String(byEnv[f.env]) });
    }
  });
});
