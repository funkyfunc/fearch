/**
 * Freshness: when was this page last updated, and is that old enough to warn about?
 * Sources, in order of trust: Last-Modified header, article:modified_time / article:published_time,
 * JSON-LD dateModified/datePublished, <time datetime>, <meta name="date">.
 */

import * as cheerio from "cheerio";

export interface Freshness {
  date?: string; // ISO date (YYYY-MM-DD)
  source?: string;
  ageDays?: number;
  stale: boolean;
}

const STALE_AFTER_DAYS = 365;

function iso(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function parse(s: string | undefined | null): Date | null {
  if (!s) return null;
  const t = Date.parse(s.trim());
  if (!Number.isFinite(t)) return null;
  const d = new Date(t);
  if (d.getFullYear() < 1995 || d.getTime() > Date.now() + 86_400_000) return null;
  return d;
}

export function freshness(headers: Record<string, string>, html?: string, now = Date.now()): Freshness {
  const candidates: Array<[string, Date | null]> = [];
  if (html) {
    try {
      const $ = cheerio.load(html.slice(0, 300_000));
      candidates.push(["article:modified_time", parse($('meta[property="article:modified_time"]').attr("content"))]);
      candidates.push(["article:published_time", parse($('meta[property="article:published_time"]').attr("content"))]);
      $('script[type="application/ld+json"]').each((_, el) => {
        try {
          const data = JSON.parse($(el).text());
          const nodes = Array.isArray(data) ? data : [data, ...(data["@graph"] ?? [])];
          for (const n of nodes) {
            if (n?.dateModified) candidates.push(["ld+json dateModified", parse(String(n.dateModified))]);
            if (n?.datePublished) candidates.push(["ld+json datePublished", parse(String(n.datePublished))]);
          }
        } catch {
          // ignore malformed JSON-LD
        }
      });
      candidates.push([
        "meta date",
        parse($('meta[name="date"], meta[name="last-modified"], meta[name="dcterms.modified"]').attr("content")),
      ]);
      const t = $("time[datetime]").first().attr("datetime");
      candidates.push(["<time>", parse(t)]);
    } catch {
      // best effort
    }
  }
  candidates.push(["Last-Modified", parse(headers["last-modified"])]);
  const pick = candidates.find(([, d]) => d);
  if (!pick || !pick[1]) return { stale: false };
  const ageDays = Math.max(0, Math.floor((now - pick[1].getTime()) / 86_400_000));
  return { date: iso(pick[1]), source: pick[0], ageDays, stale: ageDays > STALE_AFTER_DAYS };
}

export function describeAge(f: Freshness): string {
  if (!f.date) return "";
  const d = f.ageDays ?? 0;
  const rel =
    d < 1 ? "today" : d < 30 ? `${d}d ago` : d < 365 ? `${Math.round(d / 30)}mo ago` : `${(d / 365).toFixed(1)}y ago`;
  return `updated ${f.date} (${rel})${f.stale ? " ⚠ may be stale" : ""}`;
}
