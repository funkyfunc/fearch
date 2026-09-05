/**
 * Bot checks waiting for the person's answer across tool calls. Under the multi-round-trip model a
 * tool cannot block on the person: the render that hit the check registers how to continue, the tool
 * returns `input_required`, and the client's next call — carrying the answer — resumes it here. A
 * check nobody comes back for expires and its tab is closed.
 */

import { randomUUID } from "node:crypto";
import type { HandoffContinuation, Rendered } from "./browser.js";

export interface PendingInfo {
  url: string;
  where: string;
  message?: string;
}

export class PendingCheckGone extends Error {
  constructor(id: string) {
    super(`The bot check (${id}) is no longer waiting — it expired or was answered already; fetch the URL again.`);
    this.name = "PendingCheckGone";
  }
}

export class PendingChecks {
  private readonly checks = new Map<string, { info: PendingInfo; cont: HandoffContinuation; timer: NodeJS.Timeout }>();

  constructor(private readonly ttlMs: number) {}

  register(info: PendingInfo, cont: HandoffContinuation): string {
    const id = randomUUID();
    const timer = setTimeout(() => void this.expire(id), this.ttlMs);
    timer.unref();
    this.checks.set(id, { info, cont, timer });
    return id;
  }

  info(id: string): PendingInfo | undefined {
    return this.checks.get(id)?.info;
  }

  get size(): number {
    return this.checks.size;
  }

  /** Continue the render with the person's answer; the check is consumed either way. */
  async resume(id: string, answer: "accept" | "declined"): Promise<Rendered> {
    const p = this.checks.get(id);
    if (!p) throw new PendingCheckGone(id);
    clearTimeout(p.timer);
    this.checks.delete(id);
    return p.cont.resume(answer);
  }

  private async expire(id: string): Promise<void> {
    const p = this.checks.get(id);
    if (!p) return;
    this.checks.delete(id);
    await p.cont.cancel().catch(() => {});
  }

  async close(): Promise<void> {
    for (const id of [...this.checks.keys()]) await this.expire(id);
  }
}
