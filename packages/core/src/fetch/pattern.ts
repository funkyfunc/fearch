/**
 * `pattern=` read mode: regex matches with surrounding context and absolute positions, so the model
 * can answer "does this page mention X, and where" for almost no tokens, then read around a match
 * with `cursor`. (Idea from scrapling-fetch-mcp's s_fetch_pattern.)
 */

import { runInNewContext } from "node:vm";
import { BadRequest } from "./errors.js";

const MAX_PATTERN_CHARS = 500;
/** A model-written regex can backtrack catastrophically; the match runs under a hard time limit. */
const MATCH_TIMEOUT_MS = 2000;

export interface PatternMatch {
  start: number;
  end: number;
  text: string;
  matches: number;
}

export function findPattern(
  md: string,
  pattern: string,
  contextChars = 200,
  maxWindows = 20,
): { windows: PatternMatch[]; total: number } {
  if (pattern.length > MAX_PATTERN_CHARS)
    throw new BadRequest(`Pattern is ${pattern.length} chars; keep it under ${MAX_PATTERN_CHARS}.`);
  let re: RegExp;
  try {
    // gim: case-insensitive by default, and ^/$ anchor to lines — the way people write grep patterns.
    re = new RegExp(pattern, "gim");
  } catch (e) {
    const hint = /\(\?[a-z]+\)/.test(pattern)
      ? " (inline flags like (?i) are not supported; matching is already case-insensitive and multiline)"
      : "";
    throw new BadRequest(`Invalid pattern ${JSON.stringify(pattern)}: ${(e as Error).message}${hint}`);
  }
  let hits: Array<[number, number]>;
  try {
    hits = runInNewContext(
      "const out = []; for (const m of md.matchAll(re)) { if (!m[0].length) continue; out.push([m.index, m.index + m[0].length]); if (out.length >= 500) break; } out",
      { md, re },
      { timeout: MATCH_TIMEOUT_MS },
    ) as Array<[number, number]>;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ERR_SCRIPT_EXECUTION_TIMEOUT")
      throw new BadRequest(
        `Pattern ${JSON.stringify(pattern)} took more than ${MATCH_TIMEOUT_MS / 1000} s on this page; simplify it (nested quantifiers backtrack).`,
      );
    throw e;
  }
  if (!hits.length) return { windows: [], total: 0 };
  // Expand to context windows, snapping to line boundaries, and merge overlaps.
  const windows: PatternMatch[] = [];
  for (const [s, e] of hits) {
    let ws = Math.max(0, s - contextChars);
    let we = Math.min(md.length, e + contextChars);
    const nl = md.lastIndexOf("\n", ws);
    if (nl >= 0 && ws - nl < 80) ws = nl + 1;
    const nr = md.indexOf("\n", we);
    if (nr >= 0 && nr - we < 80) we = nr;
    const last = windows[windows.length - 1];
    if (last && ws <= last.end) {
      last.end = Math.max(last.end, we);
      last.matches++;
    } else {
      windows.push({ start: ws, end: we, text: "", matches: 1 });
    }
  }
  for (const w of windows) w.text = md.slice(w.start, w.end).trim();
  return { windows: windows.slice(0, maxWindows), total: hits.length };
}

export function renderPattern(
  pattern: string,
  res: { windows: PatternMatch[]; total: number },
  docLength: number,
): string {
  if (!res.total) return `Pattern /${pattern}/i: no matches in ${docLength} chars.`;
  const shown = res.windows.reduce((a, w) => a + w.matches, 0);
  const lines = [
    `Pattern /${pattern}/i: ${res.total} match${res.total === 1 ? "" : "es"} in ${docLength} chars; showing ${res.windows.length} window${res.windows.length === 1 ? "" : "s"} (${shown} matches).`,
    "",
  ];
  for (const w of res.windows) {
    lines.push(`[Position: ${w.start}-${w.end}]`, w.text, "");
  }
  lines.push("To read around a match, fetch with mode=read and cursor=<position>.");
  return lines.join("\n");
}
