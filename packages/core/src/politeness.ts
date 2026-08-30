/**
 * Per-host politeness (one request at a time, a minimum gap between requests, Crawl-delay honored)
 * and a per-session call budget that refuses with an explanation instead of hammering.
 */

export class BudgetExceeded extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BudgetExceeded";
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class Politeness {
  private readonly queues = new Map<string, Promise<void>>();
  private readonly lastDone = new Map<string, number>();
  private readonly calls: number[] = [];

  constructor(
    private readonly minGapMs = 1000,
    private readonly budget = { count: 60, windowMs: 10 * 60_000 },
    private readonly now: () => number = () => Date.now(),
    private readonly wait: (ms: number) => Promise<void> = sleep,
  ) {}

  /** Number of calls still available in the current window. */
  remaining(): number {
    const cutoff = this.now() - this.budget.windowMs;
    while (this.calls.length && this.calls[0] < cutoff) this.calls.shift();
    return Math.max(0, this.budget.count - this.calls.length);
  }

  /** Reserve a budget slot or throw an explanatory error. */
  charge(): void {
    if (this.remaining() <= 0) {
      const minutes = Math.round(this.budget.windowMs / 60_000);
      throw new BudgetExceeded(
        `Session fetch budget exhausted (${this.budget.count} requests per ${minutes} min). This limit exists so the ` +
          `server never overwhelms websites. Reuse what you already fetched, narrow with focus=/section=, or wait.`,
      );
    }
    this.calls.push(this.now());
  }

  /** Run `fn` for `host`, serialized per host with at least `gapMs` (default minGapMs) since the last request there. */
  async run<T>(host: string, fn: () => Promise<T>, gapMs?: number): Promise<T> {
    const gap = Math.max(this.minGapMs, gapMs ?? 0);
    const prev = this.queues.get(host) ?? Promise.resolve();
    let release!: () => void;
    const mine = new Promise<void>((r) => (release = r));
    this.queues.set(
      host,
      prev.then(() => mine),
    );
    await prev;
    try {
      const since = this.now() - (this.lastDone.get(host) ?? -Infinity);
      if (since < gap) await this.wait(gap - since);
      return await fn();
    } finally {
      this.lastDone.set(host, this.now());
      release();
      if (this.queues.get(host) === prev.then(() => mine)) this.queues.delete(host);
    }
  }
}
