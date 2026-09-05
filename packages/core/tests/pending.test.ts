import { describe, expect, it } from "vitest";
import type { HandoffContinuation, Rendered } from "../src/fetch/browser.js";
import { PendingCheckGone, PendingChecks } from "../src/fetch/pending.js";

const rendered = (answer: string): Rendered => ({
  html: `<p>${answer}</p>`,
  finalUrl: "https://x.test/",
  status: 200,
  salvaged: false,
  usedSession: false,
  handedOff: answer === "accept",
});

function continuation() {
  const calls: string[] = [];
  const cont: HandoffContinuation = {
    async resume(answer) {
      calls.push(answer);
      return rendered(answer);
    },
    async cancel() {
      calls.push("cancel");
    },
  };
  return { cont, calls };
}

describe("PendingChecks", () => {
  it("resumes a registered check once with the person's answer, then forgets it", async () => {
    const pending = new PendingChecks(60_000);
    const { cont, calls } = continuation();
    const id = pending.register({ url: "https://x.test/", where: "a window" }, cont);
    expect(pending.size).toBe(1);
    expect(pending.info(id)?.where).toBe("a window");
    const r = await pending.resume(id, "accept");
    expect(r.handedOff).toBe(true);
    expect(calls).toEqual(["accept"]);
    expect(pending.size).toBe(0);
    await expect(pending.resume(id, "accept")).rejects.toBeInstanceOf(PendingCheckGone);
    await expect(pending.resume("nope", "declined")).rejects.toThrow(/no longer waiting/);
  });

  it("cancels a check nobody came back for when it expires, and everything on close", async () => {
    const pending = new PendingChecks(30);
    const a = continuation();
    const b = continuation();
    pending.register({ url: "https://a.test/", where: "a tab" }, a.cont);
    await new Promise((r) => setTimeout(r, 80));
    expect(a.calls).toEqual(["cancel"]);
    expect(pending.size).toBe(0);
    const long = new PendingChecks(60_000);
    long.register({ url: "https://b.test/", where: "a tab" }, b.cont);
    await long.close();
    expect(b.calls).toEqual(["cancel"]);
    expect(long.size).toBe(0);
  });
});
