import { describe, expect, it } from "vitest";
import { BudgetExceeded, Politeness } from "../src/politeness.js";

describe("politeness", () => {
  it("serializes per host and enforces the gap, independently across hosts", async () => {
    let clock = 0;
    const waits: number[] = [];
    const p = new Politeness(1000, { count: 100, windowMs: 60_000 }, () => clock, async (ms) => {
      waits.push(ms);
      clock += ms;
    });
    const order: string[] = [];
    await Promise.all([
      p.run("a.test", async () => {
        order.push("a1");
        clock += 10;
      }),
      p.run("a.test", async () => {
        order.push("a2");
      }),
      p.run("b.test", async () => {
        order.push("b1");
      }),
    ]);
    expect(order[0]).toBe("a1");
    expect(order).toContain("a2");
    expect(order).toContain("b1");
    // a2 had to wait the full gap after a1 finished; b1 waited for nothing
    expect(waits).toEqual([1000]);
  });

  it("honours a larger crawl-delay", async () => {
    let clock = 0;
    const waits: number[] = [];
    const p = new Politeness(1000, { count: 100, windowMs: 60_000 }, () => clock, async (ms) => {
      waits.push(ms);
      clock += ms;
    });
    await p.run("a.test", async () => {}, 5000);
    await p.run("a.test", async () => {}, 5000);
    expect(waits).toEqual([5000]);
  });

  it("refuses with an explanation when the budget is exhausted", () => {
    let clock = 0;
    const p = new Politeness(0, { count: 2, windowMs: 1000 }, () => clock);
    p.charge();
    p.charge();
    expect(() => p.charge()).toThrow(BudgetExceeded);
    expect(() => p.charge()).toThrow(/never overwhelms websites/);
    clock = 2000;
    expect(p.remaining()).toBe(2);
  });
});
