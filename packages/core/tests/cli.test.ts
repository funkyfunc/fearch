import { describe, expect, it } from "vitest";
import { parseArgs } from "../src/cli/args.js";
import { settingsFromArgs, UsageError } from "../src/config.js";

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
