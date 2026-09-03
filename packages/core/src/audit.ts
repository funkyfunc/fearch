/** Structured audit log (one JSON line per network request) and a small stderr logger. stdout is never touched. */

import { appendFileSync } from "node:fs";
import type { Settings } from "./config.js";

export interface AuditEvent {
  url: string;
  method?: string;
  status?: number | string;
  bytes?: number;
  robots?: "allowed" | "disallowed" | "skipped" | "api" | "unavailable";
  provider?: string;
  cache?: "hit" | "miss" | "revalidated" | "bypass";
  note?: string;
  ms?: number;
}

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const;

export class Audit {
  constructor(
    private readonly settings: Pick<Settings, "auditLog" | "logLevel"> & Partial<Pick<Settings, "logFile">>,
  ) {}

  private tee(line: string): void {
    if (!this.settings.logFile) return;
    try {
      appendFileSync(this.settings.logFile, line + "\n");
    } catch {
      /* the file is a convenience; never fail a request over it */
    }
  }

  record(ev: AuditEvent): void {
    if (this.settings.auditLog === "off") return;
    const line = JSON.stringify({ ts: new Date().toISOString(), ...ev });
    this.tee(`AUDIT ${line}`);
    if (this.settings.auditLog === "stderr") process.stderr.write(`AUDIT ${line}\n`);
    else {
      try {
        appendFileSync(this.settings.auditLog, line + "\n");
      } catch (e) {
        process.stderr.write(`AUDIT (file write failed: ${(e as Error).message}) ${line}\n`);
      }
    }
  }

  log(level: keyof typeof LEVELS, msg: string): void {
    if (LEVELS[level] < LEVELS[this.settings.logLevel]) return;
    this.tee(`${new Date().toISOString()} ${level.toUpperCase()} ${msg}`);
    process.stderr.write(`${level.toUpperCase()} fearch: ${msg}\n`);
  }
}
