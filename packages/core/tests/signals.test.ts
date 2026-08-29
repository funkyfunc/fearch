import { describe, expect, it } from "vitest";
import { Cache } from "../src/cache.js";
import { RobotsChecker, robotsContentSignalNoAiInput } from "../src/fetch/robots.js";
import { knownLicence, licenceSignals, parseContentSignal } from "../src/fetch/signals.js";

describe("content signals and licences", () => {
  it("parses Content-Signal headers", () => {
    const cs = parseContentSignal("search=yes, ai-input=no, ai-train=no")!;
    expect(cs).toMatchObject({ search: true, aiInput: false, aiTrain: false });
    expect(parseContentSignal(undefined)).toBeNull();
    expect(licenceSignals({ "content-signal": "ai-train=no" })).toContain("Content-Signal: ai-train=no");
  });

  it("finds ai-input=no in robots.txt and the checker refuses under default policy but not minimal", async () => {
    const body = "User-agent: *\nContent-Signal: search=yes, ai-input=no\nAllow: /\n";
    expect(robotsContentSignalNoAiInput(body)).toBe("search=yes, ai-input=no");
    expect(robotsContentSignalNoAiInput("User-agent: *\nContent-Signal: ai-train=no\n")).toBeNull();
    const fetcher = async () => ({ status: 200, body });
    const strict = await new RobotsChecker(new Cache(null), fetcher).check("https://example.com/page");
    expect(strict.allowed).toBe(false);
    expect(strict.contentSignal).toContain("ai-input=no");
    const minimal = await new RobotsChecker(new Cache(null), fetcher, false, "minimal").check("https://example.com/page");
    expect(minimal.allowed).toBe(true);
  });

  it("knows CC BY-SA hosts", () => {
    expect(knownLicence("en.wikipedia.org")).toContain("CC BY-SA 4.0");
    expect(knownLicence("stackoverflow.com")).toContain("attribute");
    expect(knownLicence("developer.mozilla.org")).toContain("CC BY-SA 2.5");
    expect(knownLicence("example.com")).toBeNull();
  });
});
