/** The auto tier: headless until a challenge, then one visible window, then graceful backoff. */
import { describe, expect, it } from "vitest";
import { Audit } from "../src/audit.js";
import { settingsFromEnv } from "../src/config.js";
import { EscalatingRenderer, type BrowserTier, type Rendered, type RenderOptions } from "../src/fetch/browser.js";

const settings = (env: Record<string, string> = {}) =>
  settingsFromEnv(
    { FEARCH_NO_CACHE: "1", FEARCH_AUDIT_LOG: "off", FEARCH_LOG_LEVEL: "error", DISPLAY: ":0", ...env },
    "linux",
  );
const audit = () => new Audit({ auditLog: "off", logLevel: "error" });
const page = (html: string, over: Partial<Rendered> = {}): Rendered => ({
  html,
  finalUrl: "https://x.test/",
  status: 200,
  salvaged: false,
  usedSession: false,
  handedOff: false,
  ...over,
});
const isChallenge = (h: string) => /captcha/.test(h);

function tier(render: (url: string, opts?: RenderOptions) => Promise<Rendered>) {
  const t = {
    calls: 0,
    closes: 0,
    enabled: () => true,
    headed: false,
    browserUserAgent: "ua",
    browserChannel: "chromium",
    render: async (u: string, o?: RenderOptions) => {
      t.calls++;
      return render(u, o);
    },
    close: async () => {
      t.closes++;
    },
  };
  return t as typeof t & BrowserTier;
}

describe("EscalatingRenderer", () => {
  it("stays headless for ordinary pages and never builds the escalation browser", async () => {
    const routine = tier(async () => page("<main>fine</main>"));
    let built = 0;
    const r = new EscalatingRenderer(settings(), audit(), routine, () => {
      built++;
      return tier(async () => page("<main>window</main>"));
    });
    const out = await r.render("https://x.test/", { isChallenge });
    expect(out.html).toContain("fine");
    expect(built).toBe(0);
  });

  it("escalates a challenge to the window; a passed check restarts the routine renderer", async () => {
    const routine = tier(async () => page("<b>captcha</b>"));
    const escalation = tier(async (_u, o) => {
      expect(o?.session).toBe(true);
      return page("<main>results</main>", { handedOff: true });
    });
    const r = new EscalatingRenderer(settings(), audit(), routine, () => escalation);
    const out = await r.render("https://x.test/", { isChallenge });
    expect(out.html).toContain("results");
    expect(out.handedOff).toBe(true);
    expect(routine.closes).toBe(1); // reload the profile the person just changed
  });

  it("backs off after an unanswered window instead of reopening one per request", async () => {
    const routine = tier(async () => page("<b>captcha</b>"));
    const escalation = tier(async () => page("<b>captcha</b>"));
    const r = new EscalatingRenderer(settings(), audit(), routine, () => escalation);
    const first = await r.render("https://x.test/", { isChallenge });
    expect(isChallenge(first.html)).toBe(true);
    await r.render("https://x.test/", { isChallenge });
    expect(escalation.calls).toBe(1); // away cooldown: no second window
    expect(routine.calls).toBe(2);
  });

  it("remembers that no window can be opened here and degrades to plain headless behaviour", async () => {
    const routine = tier(async () => page("<b>captcha</b>"));
    const escalation = tier(async () => {
      throw new Error("Chromium could not be launched (Missing X server)");
    });
    const r = new EscalatingRenderer(settings(), audit(), routine, () => escalation);
    const out = await r.render("https://x.test/", { isChallenge });
    expect(isChallenge(out.html)).toBe(true);
    await r.render("https://x.test/", { isChallenge });
    expect(escalation.calls).toBe(1); // permanent: not retried
  });

  it("never escalates when handoff is declined or nothing can be surfaced", async () => {
    const routine = tier(async () => page("<b>captcha</b>"));
    let built = 0;
    const make = () => {
      built++;
      return tier(async () => page("ok"));
    };
    const declined = new EscalatingRenderer(settings(), audit(), routine, make);
    await declined.render("https://x.test/", { isChallenge, handoff: false });
    const noDisplay = new EscalatingRenderer(settings({ DISPLAY: "" }), audit(), routine, make);
    await noDisplay.render("https://x.test/", { isChallenge });
    const optedOut = new EscalatingRenderer(settings({ FEARCH_HANDOFF: "0" }), audit(), routine, make);
    await optedOut.render("https://x.test/", { isChallenge });
    expect(built).toBe(0);
  });
});
