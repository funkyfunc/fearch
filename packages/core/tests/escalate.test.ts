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
    expect(escalation.closes).toBe(1); // the unanswered window is closed, never orphaned
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

  it("a page meant for the person's hands skips the headless attempt and goes straight to the window", async () => {
    const routine = tier(async () => page("<main>never</main>"));
    const escalation = tier(async (_u, o) => {
      expect(o?.handToPerson?.message).toBe("press Enter");
      return page("<main>results</main>", { handedOff: true, handoffWhere: "a browser window on your screen" });
    });
    const r = new EscalatingRenderer(settings(), audit(), routine, () => escalation);
    const out = await r.render("https://x.test/", { handToPerson: { message: "press Enter", ready: () => true } });
    expect(out.handedOff).toBe(true);
    expect(routine.calls).toBe(0);
    // with nothing to show, it is refused rather than attempted headless
    const none = new EscalatingRenderer(settings({ DISPLAY: "" }), audit(), routine, () => escalation);
    await expect(none.render("https://x.test/", { handToPerson: { message: "m", ready: () => true } })).rejects.toThrow(
      /visible window/,
    );
    expect(routine.calls).toBe(0);
  });

  it("with a client that can ask: the prompt gates the window; a decline opens nothing and is not held against the next request", async () => {
    const routine = tier(async () => page("<b>captcha</b>"));
    const escalation = tier(async (_u, o) => {
      expect(o?.handoffApproved).toBe(true); // the window must not ask a second time
      return page("<main>results</main>", { handedOff: true, handoff: "passed" });
    });
    let answer: "accept" | "declined" = "declined";
    const asked: string[] = [];
    const gate = {
      ask: async (i: { url: string; where: string }) => {
        asked.push(i.where);
        return answer;
      },
    };
    const r = new EscalatingRenderer(settings(), audit(), routine, () => escalation, undefined, gate);
    const declined = await r.render("https://x.test/", { isChallenge });
    expect(declined.handoff).toBe("declined");
    expect(escalation.calls).toBe(0);
    // no away backoff after a decline: the next request asks again
    answer = "accept";
    const passed = await r.render("https://x.test/", { isChallenge });
    expect(passed.handoff).toBe("passed");
    expect(escalation.calls).toBe(1);
    expect(asked).toEqual(Array(2).fill("a browser window on your screen"));
  });

  it("opens engine pages (session) in the real window, minimised, never headless; refuses where none can be shown", async () => {
    const routine = tier(async () => page("<main>never headless</main>"));
    const seen: RenderOptions[] = [];
    const escalation = tier(async (_u, o) => {
      seen.push(o ?? {});
      return page("<main>results</main>");
    });
    const r = new EscalatingRenderer(settings(), audit(), routine, () => escalation);
    const out = await r.render("https://lite.duckduckgo.com/lite/?q=x", { session: true, isChallenge });
    expect(out.html).toContain("results");
    expect(routine.calls).toBe(0);
    expect(seen[0]).toMatchObject({ session: true, background: true, handoff: true });
    // handoff off: the window still opens (a real browser is the point), but no check is handed over
    const quiet = new EscalatingRenderer(settings({ FEARCH_HANDOFF: "0" }), audit(), routine, () => escalation);
    await quiet.render("https://x.test/", { session: true });
    expect(seen[1]).toMatchObject({ background: true, handoff: false });
    // nothing can be shown: an honest refusal, not a headless render
    const none = new EscalatingRenderer(settings({ DISPLAY: "" }), audit(), routine, () => escalation);
    await expect(none.render("https://x.test/", { session: true })).rejects.toThrow(/none can be shown/);
    expect(routine.calls).toBe(0);
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
