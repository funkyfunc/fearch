/**
 * Turning a fetched document into what the model sees: one of five read modes over the same markdown,
 * bounded by a character budget and resumable with a cursor.
 *
 *   read     the page from an offset, with an outline of the sections not shown
 *   focus    only the sections BM25-relevant to a phrase
 *   section  one heading and its subsections
 *   pattern  regex matches with context and positions
 *   raw      the unprocessed body
 */

import { applyBudget } from "./budget.js";
import { makeCursor, resolveCursor, viewId } from "./cursor.js";
import { describeAge } from "./freshness.js";
import { findPattern, renderPattern } from "./pattern.js";
import type { PageDoc } from "./pipeline.js";
import { applyLinkMode, renderPage } from "./render.js";
import { findSection, focusSections, joinSections, renderOutline, splitSections, type Section } from "./sections.js";

export type ReadMode = "read" | "focus" | "section" | "pattern" | "raw";
export const READ_MODES: readonly ReadMode[] = ["read", "focus", "section", "pattern", "raw"];

export interface ReadOptions {
  mode: ReadMode;
  /** Phrase (focus), heading (section), or regex (pattern). */
  query?: string;
  maxChars: number;
  cursor?: string;
  includeLinks: boolean;
  contextChars?: number;
}

export class SectionNotFound extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SectionNotFound";
  }
}
export class BadRequest extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BadRequest";
  }
}

export function readDocument(doc: PageDoc, o: ReadOptions): string {
  const view = viewId(o.mode, o.query);
  const { offset, note: cursorNote } = resolveCursor(o.cursor, view);
  const notes = [doc.note, cursorNote].filter(Boolean) as string[];
  const page = { title: doc.title, url: doc.finalUrl, source: doc.source, facts: headerFacts(doc) };

  if (o.mode === "raw") {
    const window = applyBudget(doc.markdown, offset, o.maxChars);
    return renderPage({ ...page, window, note: notes.join(" "), nextCursor: makeCursor(window.end, view) });
  }
  if (o.mode === "pattern") {
    const { body } = applyLinkMode(doc.markdown, false);
    const matches = findPattern(body, requireQuery(o, "a regex"), o.contextChars ?? 200);
    const window = applyBudget(renderPattern(o.query!, matches, body.length), 0, o.maxChars);
    return renderPage({ ...page, window: { ...window, total: 0 }, note: notes.join(" ") });
  }

  const sections = splitSections(doc.markdown);
  let selected: Section[] = sections;
  if (o.mode === "section") {
    const found = findSection(sections, requireQuery(o, "a heading"));
    if (!found) throw new SectionNotFound(noSuchSection(doc.finalUrl, o.query!, sections));
    selected = found;
    notes.push(`Section: '${o.query}'.`);
  } else if (o.mode === "focus") {
    selected = focusSections(sections, requireQuery(o, "what you are looking for"), o.maxChars);
    notes.push(`Focus: '${o.query}'.`);
  }

  const { body, footer } = applyLinkMode(o.mode === "read" ? doc.markdown : joinSections(selected), o.includeLinks);
  const window = applyBudget(body, offset, o.maxChars);
  // In read mode the sections "shown" are whatever the window covers; otherwise the ones selected.
  const shown =
    o.mode === "read" && window.truncated
      ? new Set(sections.filter((s) => s.start < window.end && s.end > window.start).map((s) => s.index))
      : new Set(selected.map((s) => s.index));
  return renderPage({
    ...page,
    window,
    outline: o.mode === "read" && !window.truncated ? "" : renderOutline(sections, shown),
    linksFooter: footer,
    note: notes.join(" "),
    sections: { shown: shown.size, total: sections.length },
    nextCursor: makeCursor(window.end, view),
  });
}

function headerFacts(doc: PageDoc): string[] {
  const facts: string[] = [];
  if (doc.robots) facts.push(`robots: ${doc.robots}`);
  if (doc.updated) facts.push(describeAge(doc.updated));
  if (doc.licence.length) facts.push(`licence: ${doc.licence.join(" | ")}`);
  return facts;
}

function requireQuery(o: ReadOptions, what: string): string {
  if (!o.query) throw new BadRequest(`mode=${o.mode} needs \`query\` (${what}).`);
  return o.query;
}

function noSuchSection(url: string, query: string, sections: Section[]): string {
  const available = sections
    .filter((s) => s.level > 0)
    .map((s) => s.title)
    .join(" · ")
    .slice(0, 2000);
  return `No section matching '${query}' on ${url}. Available sections: ${available || "(none — page has no headings)"}`;
}
