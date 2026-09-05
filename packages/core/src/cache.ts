/**
 * On-disk sqlite cache (node:sqlite, no native build): extracted pages with validators for
 * conditional requests, search results, and robots.txt bodies. Cross-session caching is the most
 * respectful feature after robots.txt — it removes repeat traffic entirely.
 */

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Freshness } from "./fetch/freshness.js";

export const SEARCH_TTL_MS = 15 * 60_000;
export const ROBOTS_TTL_MS = 3600_000;

export interface CachedPage {
  url: string;
  finalUrl: string;
  title: string;
  source: string;
  markdown: string;
  etag: string | null;
  lastModified: string | null;
  licence: string | null;
  updated: Freshness | null;
  fetchedAt: number;
}

export interface CachedRobots {
  host: string;
  status: number;
  body: string;
  fetchedAt: number;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS pages (
  url TEXT PRIMARY KEY, final_url TEXT, title TEXT, source TEXT, markdown TEXT,
  etag TEXT, last_modified TEXT, licence TEXT, updated TEXT, fetched_at REAL
);
CREATE TABLE IF NOT EXISTS searches (key TEXT PRIMARY KEY, results TEXT, fetched_at REAL);
CREATE TABLE IF NOT EXISTS robots (host TEXT PRIMARY KEY, status INTEGER, body TEXT, fetched_at REAL);
CREATE TABLE IF NOT EXISTS hosts (host TEXT PRIMARY KEY, needs_browser_until REAL);
`;

const SCHEMA_VERSION = 4;

export class Cache {
  private readonly db: DatabaseSync;

  constructor(path: string | null) {
    if (path) mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path ?? ":memory:");
    const version = (this.db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
    if (version !== SCHEMA_VERSION) {
      // Any older layout (including the v1 Python server's) is simply dropped — it's a cache.
      this.db.exec(
        "DROP TABLE IF EXISTS pages; DROP TABLE IF EXISTS searches; DROP TABLE IF EXISTS robots; DROP TABLE IF EXISTS hosts;",
      );
      this.db.exec(SCHEMA);
      this.db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    } else {
      this.db.exec(SCHEMA);
    }
  }

  /** The cached page whatever its age: the pipeline decides whether to serve or revalidate it. */
  getPage(url: string): CachedPage | null {
    const row = this.db
      .prepare(
        "SELECT url, final_url, title, source, markdown, etag, last_modified, licence, updated, fetched_at FROM pages WHERE url = ?",
      )
      .get(url) as Record<string, string | number | null> | undefined;
    if (!row) return null;
    const fetchedAt = Number(row.fetched_at);
    let updated: Freshness | null = null;
    if (row.updated) {
      try {
        updated = JSON.parse(String(row.updated)) as Freshness;
      } catch {
        updated = null;
      }
    }
    return {
      url: String(row.url),
      finalUrl: String(row.final_url ?? ""),
      title: String(row.title ?? ""),
      source: String(row.source ?? ""),
      markdown: String(row.markdown ?? ""),
      etag: (row.etag as string | null) ?? null,
      lastModified: (row.last_modified as string | null) ?? null,
      licence: (row.licence as string | null) ?? null,
      updated,
      fetchedAt,
    };
  }

  setPage(p: Omit<CachedPage, "fetchedAt">): void {
    this.db
      .prepare("INSERT OR REPLACE INTO pages VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(
        p.url,
        p.finalUrl,
        p.title,
        p.source,
        p.markdown,
        p.etag,
        p.lastModified,
        p.licence,
        p.updated ? JSON.stringify(p.updated) : null,
        Date.now(),
      );
  }

  touchPage(url: string): void {
    this.db.prepare("UPDATE pages SET fetched_at = ? WHERE url = ?").run(Date.now(), url);
  }

  getSearch<T>(key: string): T | null {
    const row = this.db.prepare("SELECT results, fetched_at FROM searches WHERE key = ?").get(key) as
      { results: string; fetched_at: number } | undefined;
    if (!row || Date.now() - Number(row.fetched_at) > SEARCH_TTL_MS) return null;
    try {
      return JSON.parse(row.results) as T;
    } catch {
      return null; // a corrupt row is a cache miss, not a crash
    }
  }

  setSearch(key: string, results: unknown): void {
    this.db.prepare("INSERT OR REPLACE INTO searches VALUES (?, ?, ?)").run(key, JSON.stringify(results), Date.now());
  }

  getRobots(host: string): CachedRobots | null {
    const row = this.db.prepare("SELECT host, status, body, fetched_at FROM robots WHERE host = ?").get(host) as
      { host: string; status: number; body: string; fetched_at: number } | undefined;
    if (!row || Date.now() - Number(row.fetched_at) > ROBOTS_TTL_MS) return null;
    return { host: row.host, status: Number(row.status), body: row.body, fetchedAt: Number(row.fetched_at) };
  }

  setRobots(host: string, status: number, body: string): void {
    this.db.prepare("INSERT OR REPLACE INTO robots VALUES (?, ?, ?, ?)").run(host, status, body, Date.now());
  }

  /** Hosts where the plain client recently failed and the browser succeeded: go straight to the browser. */
  needsBrowser(host: string): boolean {
    const row = this.db.prepare("SELECT needs_browser_until FROM hosts WHERE host = ?").get(host) as
      { needs_browser_until: number } | undefined;
    return !!row && Number(row.needs_browser_until) > Date.now();
  }

  setNeedsBrowser(host: string, ttlMs = 24 * 3600_000): void {
    this.db.prepare("INSERT OR REPLACE INTO hosts VALUES (?, ?)").run(host, Date.now() + ttlMs);
  }

  close(): void {
    this.db.close();
  }
}
