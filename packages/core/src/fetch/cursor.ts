/**
 * Continuation cursors. A cursor is `<offset>@<view>` where `<view>` identifies the selection the
 * offset applies to (`read`, `focus:<hash>`, `section:<hash>`). Offsets only make sense within the
 * same view, so a cursor from a different view is ignored (with a note) instead of misreading the page.
 * A bare integer is accepted too, for clients that just copy the number.
 */

import { createHash } from "node:crypto";

export interface ParsedCursor {
  offset: number;
  view: string | null;
}

export function viewId(mode: string, query?: string): string {
  if (mode === "read" || mode === "raw") return mode;
  const h = createHash("sha1")
    .update(`${mode}:${(query ?? "").trim().toLowerCase()}`)
    .digest("hex")
    .slice(0, 6);
  return `${mode}:${h}`;
}

export function makeCursor(offset: number, view: string): string {
  return `${offset}@${view}`;
}

export function parseCursor(raw: string | number | undefined): ParsedCursor | null {
  if (raw === undefined || raw === null || raw === "") return { offset: 0, view: null };
  if (typeof raw === "number") return { offset: Math.max(0, Math.floor(raw)), view: null };
  const m = /^\s*(\d+)\s*(?:@\s*([\w:-]+))?\s*$/.exec(raw);
  if (!m) return null;
  return { offset: Number(m[1]), view: m[2] ?? null };
}

/**
 * Resolve the offset to use for `view`. A cursor that is not a cursor, or one that belonged to
 * another view, starts from the beginning — with a note, never silently.
 */
export function resolveCursor(raw: string | number | undefined, view: string): { offset: number; note?: string } {
  const c = parseCursor(raw);
  if (!c) {
    return {
      offset: 0,
      note: `Cursor "${raw}" is not a cursor (expected "<offset>@<view>" from a footer); starting from the beginning.`,
    };
  }
  if (c.view && c.view !== view) {
    return {
      offset: 0,
      note: `Cursor "${raw}" was for a different view (${c.view}); starting from the beginning of this one.`,
    };
  }
  return { offset: c.offset };
}
