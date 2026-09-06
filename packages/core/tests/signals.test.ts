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

  it("finds ai-input=no in robots.txt and the checker refuses", async () => {
    const body = "User-agent: *\nContent-Signal: search=yes, ai-input=no\nAllow: /\n";
    const at = "https://example.com/page";
    expect(robotsContentSignalNoAiInput(body, at, ["fearch"])).toBe("search=yes, ai-input=no");
    expect(robotsContentSignalNoAiInput("User-agent: *\nContent-Signal: ai-train=no\n", at, ["fearch"])).toBeNull();
    // Scoped the way contentsignals.org scopes it: a signal for another crawler, or for another
    // path, is not a signal to us; one in our own token's group, or under our path, is.
    const googleOnly = "User-agent: googlebot\nContent-Signal: ai-input=no\nAllow: /\n\nUser-agent: *\nAllow: /\n";
    expect(robotsContentSignalNoAiInput(googleOnly, at, ["fearch"])).toBeNull();
    const blogOnly = "User-agent: *\nContent-Signal: /blog/ ai-train=no, search=yes, ai-input=no\nAllow: /\n";
    expect(robotsContentSignalNoAiInput(blogOnly, "https://example.com/about", ["fearch"])).toBeNull();
    expect(robotsContentSignalNoAiInput(blogOnly, "https://example.com/blog/post", ["fearch"])).toContain(
      "ai-input=no",
    );
    const ours = "User-agent: Claude-User\nUser-agent: fearch\nContent-Signal: ai-input=no\nDisallow:\n";
    expect(robotsContentSignalNoAiInput(ours, at, ["fearch", "Claude-User"])).toBe("ai-input=no");
    expect(robotsContentSignalNoAiInput(ours, at, ["OtherBot"])).toBeNull();
    const fetcher = async () => ({ status: 200, body });
    const strict = await new RobotsChecker(new Cache(null), fetcher).check("https://example.com/page");
    expect(strict.allowed).toBe(false);
    expect(strict.contentSignal).toContain("ai-input=no");
  });

  it("knows CC BY-SA hosts", () => {
    expect(knownLicence("en.wikipedia.org")).toContain("CC BY-SA 4.0");
    expect(knownLicence("stackoverflow.com")).toContain("attribute");
    expect(knownLicence("developer.mozilla.org")).toContain("CC BY-SA 2.5");
    expect(knownLicence("example.com")).toBeNull();
  });
});
