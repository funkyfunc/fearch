/** Character budgeting with paragraph-boundary cuts and explicit continuation markers. */

export interface Window {
  text: string;
  start: number;
  end: number;
  total: number;
  truncated: boolean;
}

export interface FooterOptions {
  sections?: { shown: number; total: number };
  /** Opaque continuation token for the next call (see cursor.ts). */
  nextCursor?: string;
}

export function footer(w: Window, o: FooterOptions = {}): string {
  if (!w.truncated) return "";
  const pct = w.total ? Math.round(((w.end - w.start) / w.total) * 100) : 100;
  const secs = o.sections && o.sections.total > 1 ? ` ${o.sections.shown} of ${o.sections.total} sections.` : "";
  const cont = o.nextCursor ? `Continue with cursor="${o.nextCursor}"` : `Continue with cursor="${w.end}"`;
  return `[Showing ${w.start}–${w.end} of ${w.total} chars (${pct}%).${secs} ${cont}, or use mode=focus/section/pattern to jump to what you need.]`;
}

export function applyBudget(text: string, startIndex = 0, maxChars = 12_000): Window {
  const total = text.length;
  const start = Math.max(0, Math.min(startIndex, total));
  if (start >= total && total > 0) return { text: "", start, end: total, total, truncated: false };
  // A window that begins inside a fenced block (the block was longer than one budget) re-opens
  // that fence, so every page is valid markdown on its own.
  const before = text.slice(0, start);
  const openBefore = (before.match(/```/g) ?? []).length % 2 === 1;
  const prefix = openBefore ? before.slice(before.lastIndexOf("```")).split("\n")[0] + "\n" : "";
  const hardEnd = Math.min(total, start + maxChars);
  if (hardEnd >= total)
    return { text: prefix + text.slice(start).replace(/^\n/, ""), start, end: total, total, truncated: false };

  const floor = start + Math.floor(maxChars * 0.75);
  let cut = text.lastIndexOf("\n\n", hardEnd);
  if (cut < floor) cut = text.lastIndexOf("\n", hardEnd);
  if (cut < floor || cut <= start) cut = hardEnd;

  let chunk = text.slice(start, cut);
  if (prefix) chunk = chunk.replace(/^\n/, ""); // the cut sat on a newline; don't open the block with a blank line
  const fences = (chunk.match(/```/g) ?? []).length + (openBefore ? 1 : 0);
  if (fences % 2 === 1) {
    const lastFence = chunk.lastIndexOf("```");
    if (!openBefore && lastFence > 0) {
      // The block that does not fit starts the next page.
      cut = start + lastFence;
      chunk = text.slice(start, cut);
    } else {
      // Mid-block: close the fence here; the next page re-opens it (see `prefix`).
      chunk = chunk.replace(/\n+$/, "") + "\n```";
    }
  }
  return { text: (prefix + chunk).replace(/\n+$/, "") + "\n", start, end: cut, total, truncated: cut < total };
}
