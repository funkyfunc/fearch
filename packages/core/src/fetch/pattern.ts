/**
 * `pattern=` read mode: regex matches with surrounding context and absolute positions, so the model
 * can answer "does this page mention X, and where" for almost no tokens, then seek with start_index.
 * (Idea from scrapling-fetch-mcp's s_fetch_pattern.)
 */

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
  let re: RegExp;
  try {
    re = new RegExp(pattern, "gi");
  } catch (e) {
    throw new Error(`Invalid pattern ${JSON.stringify(pattern)}: ${(e as Error).message}`);
  }
  const hits: Array<[number, number]> = [];
  for (const m of md.matchAll(re)) {
    if (m[0].length === 0) continue;
    hits.push([m.index, m.index + m[0].length]);
    if (hits.length >= 500) break;
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
