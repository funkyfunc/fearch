/**
 * Heading-aware sectioning, fuzzy section lookup, and BM25 focus ranking.
 * No LLM, no embeddings, no dependencies.
 */

export interface Section {
  level: number; // 0 = preamble
  title: string;
  path: string[];
  text: string;
  start: number;
  end: number;
  index: number;
}

const HEADING_RE = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const FENCE_RE = /^\s*(`{3,}|~{3,})/;
const MD_LINK_RE = /\[([^\]]*)\]\([^)]*\)/g;
/** Paired emphasis/code markers only: a literal `*` in a heading (`Universal "*" match`) is text. */
const MD_INLINE_RE = /(?<![\w*_`])(\*\*|__|`|\*|_)(\S(?:[^\n]*?\S)?)\1(?![\w*_`])/g;
const TOKEN_RE = /[a-z0-9_]+(?:[.-][a-z0-9_]+)*/g;
const REFERENCE_TITLE_RE =
  /^(references?|external links?|see also|notes|footnotes|bibliography|citations?|further reading|sources|navigation|table of contents|contents)$/i;

/** Heading text without link/emphasis markup, for outlines and matching. */
export function cleanTitle(raw: string): string {
  const t = raw.replace(MD_LINK_RE, "$1").replace(MD_INLINE_RE, "$2");
  return t
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^[\s¶#]+|[\s¶#]+$/g, "");
}

/** Split markdown into heading-delimited sections; fenced code is never split. */
export function splitSections(md: string): Section[] {
  const lines = md.split("\n");
  const sections: Section[] = [];
  let inFence = false;
  let fenceMarker = "";
  let curLevel = 0;
  let curTitle = "(intro)";
  let curLines: string[] = [];
  let curStart = 0;
  let pos = 0;
  const stack: Array<[number, string]> = [];

  const flush = (end: number) => {
    const text = curLines.join("\n").replace(/^\n+|\n+$/g, "");
    if (text.trim() || sections.length) {
      const path = stack.length ? stack.map(([, t]) => t) : [curTitle];
      sections.push({ level: curLevel, title: curTitle, path, text, start: curStart, end, index: sections.length });
    }
  };

  for (const line of lines) {
    const mFence = FENCE_RE.exec(line);
    if (mFence) {
      const marker = mFence[1];
      if (!inFence) {
        inFence = true;
        fenceMarker = marker[0].repeat(3);
      } else if (line.trim().startsWith(fenceMarker)) {
        inFence = false;
      }
    }
    const m = inFence ? null : HEADING_RE.exec(line);
    if (m) {
      flush(pos);
      curLevel = m[1].length;
      curTitle = cleanTitle(m[2]) || "(untitled)";
      while (stack.length && stack[stack.length - 1][0] >= curLevel) stack.pop();
      stack.push([curLevel, curTitle]);
      curLines = [line];
      curStart = pos;
    } else {
      curLines.push(line);
    }
    pos += line.length + 1;
  }
  flush(md.length);
  if (!sections.length)
    sections.push({ level: 0, title: "(intro)", path: ["(intro)"], text: md, start: 0, end: md.length, index: 0 });
  return sections;
}

export function subtree(sections: Section[], idx: number): Section[] {
  const root = sections[idx];
  const out = [root];
  for (const s of sections.slice(idx + 1)) {
    if (s.level <= root.level && root.level > 0) break;
    out.push(s);
  }
  return out;
}

/** Similarity in [0,1] — Levenshtein ratio, roughly comparable to difflib's ratio. */
function similarity(a: string, b: string): number {
  if (a === b) return 1;
  if (!a.length || !b.length) return 0;
  const prev = new Array<number>(b.length + 1);
  const cur = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    for (let j = 0; j <= b.length; j++) prev[j] = cur[j];
  }
  return 1 - prev[b.length] / Math.max(a.length, b.length);
}

/** Fuzzy-match a heading; returns the section plus its nested subsections, or null. */
export function findSection(sections: Section[], name: string): Section[] | null {
  const target = name.trim().toLowerCase();
  if (!target) return null;
  const titles = sections.map((s) => s.title.toLowerCase());
  let i = titles.indexOf(target);
  if (i >= 0) return subtree(sections, i);
  i = titles.findIndex((t) => t.includes(target) || (target.includes(t) && t.length > 3));
  if (i >= 0) return subtree(sections, i);
  let best = -1;
  let bestScore = 0.6;
  titles.forEach((t, k) => {
    const s = similarity(target, t);
    if (s >= bestScore) {
      best = k;
      bestScore = s;
    }
  });
  return best >= 0 ? subtree(sections, best) : null;
}

/** Tokens, plus the parts of dotted/dashed identifiers so `timeout` matches `asyncio.timeout`. */
export function tokenize(text: string): string[] {
  const out: string[] = [];
  for (const t of text.toLowerCase().match(TOKEN_RE) ?? []) {
    out.push(t);
    if (/[.-]/.test(t)) for (const p of t.split(/[.-]/)) if (p.length > 1) out.push(p);
  }
  return out;
}

const STOPWORDS = new Set([
  "a",
  "an",
  "the",
  "is",
  "are",
  "was",
  "were",
  "be",
  "what",
  "which",
  "who",
  "how",
  "do",
  "does",
  "did",
  "i",
  "my",
  "me",
  "you",
  "we",
  "it",
  "its",
  "of",
  "to",
  "in",
  "on",
  "for",
  "with",
  "and",
  "or",
  "not",
  "can",
  "should",
  "when",
  "where",
  "why",
  "this",
  "that",
  "there",
  "use",
  "using",
]);

/** Query tokens without stop-words (falls back to all tokens if nothing else is left). */
export function queryTokens(query: string): string[] {
  const all = tokenize(query);
  const kept = all.filter((t) => !STOPWORDS.has(t));
  return kept.length ? kept : all;
}

/** Minimal BM25 (Okapi) over pre-tokenized documents. */
export class BM25 {
  private readonly df = new Map<string, number>();
  private readonly avgdl: number;
  private readonly tfs: Array<Map<string, number>>;
  private readonly lens: number[];

  constructor(
    private readonly docs: string[][],
    private readonly k1 = 1.5,
    private readonly b = 0.75,
  ) {
    this.tfs = docs.map((d) => {
      const m = new Map<string, number>();
      for (const t of d) m.set(t, (m.get(t) ?? 0) + 1);
      for (const t of m.keys()) this.df.set(t, (this.df.get(t) ?? 0) + 1);
      return m;
    });
    this.lens = docs.map((d) => d.length);
    this.avgdl = docs.length ? this.lens.reduce((a, c) => a + c, 0) / docs.length : 0;
  }

  scores(query: string[]): number[] {
    const n = this.docs.length;
    return this.docs.map((_, i) => {
      let score = 0;
      const tf = this.tfs[i];
      const dl = this.lens[i];
      for (const q of query) {
        const f = tf.get(q);
        if (!f) continue;
        const df = this.df.get(q) ?? 0;
        const idf = Math.log((n - df + 0.5) / (df + 0.5) + 1);
        score += idf * ((f * (this.k1 + 1)) / (f + this.k1 * (1 - this.b + (this.b * dl) / (this.avgdl || 1))));
      }
      return score;
    });
  }
}

/**
 * Rank sections by BM25 relevance to `query`; return the best ones (in document order) whose
 * combined length fits `budget`. Always returns at least one section; `matched` is false when no
 * section scored at all, so the caller can say so instead of presenting the start as relevant.
 */
export function focusSections(
  sections: Section[],
  query: string,
  budget: number,
): { sections: Section[]; matched: boolean } {
  const q = queryTokens(query);
  if (!q.length || sections.length === 1) return { sections: sections.slice(0, 1), matched: sections.length === 1 };
  const corpus = sections.map((s) => tokenize([s.title, s.title, s.title, s.path.join(" "), s.text].join(" ")));
  const scores = new BM25(corpus).scores(q);
  const best = Math.max(0, ...scores);
  const ranked = sections.map((s, i) => {
    const titleTokens = tokenize(s.title);
    const hit = (t: string) => titleTokens.some((tt) => tt === t || (t.length >= 4 && tt.startsWith(t)));
    // A heading that names the query ("Task cancellation" for "cancel") beats a long section that
    // merely mentions the word often: it scores at least as well as the best section, and the more
    // of the heading the query fills, the better ("Task cancellation" over "Shielding from
    // cancellation"). Word prefixes count, so an inflected heading matches even when its body never
    // uses the stem. The heading is the stronger signal, so the code-block boost is skipped for it.
    const named = q.every(hit);
    const fill = titleTokens.length
      ? titleTokens.filter((tt) => q.some((t) => tt === t || tt.startsWith(t))).length / titleTokens.length
      : 0;
    let boost = 1;
    if (s.level >= 1 && s.level <= 2) boost *= 1.3;
    if (!named && s.text.includes("```")) boost *= 1.2;
    if (s.level === 0 && s.text.length < 400) boost *= 0.8;
    const base = named ? Math.max(scores[i], best) * (1 + 2 * fill) : scores[i];
    return { score: base * boost, s, reference: REFERENCE_TITLE_RE.test(s.title) };
  });
  ranked.sort((a, b) => b.score - a.score);
  // Reference lists repeat the page's key terms without saying anything about them: consider them
  // only when no substantive section matched at all.
  const substantive = ranked.filter((r) => !r.reference);
  if (substantive.some((r) => r.score > 0)) ranked.splice(0, ranked.length, ...substantive);
  const chosen: Section[] = [];
  let used = 0;
  // The lead section (before the first heading) is usually the best answer to "what is X";
  // include it first when it is substantive and fits in half the budget.
  const lead = sections[0];
  if (lead.level === 0 && lead.text.trim().length >= 200 && lead.text.length <= budget * 0.6) {
    chosen.push(lead);
    used += lead.text.length;
  }
  const top = ranked[0]?.score ?? 0;
  let pickedTop = false;
  for (const { score, s } of ranked) {
    if (chosen.includes(s)) continue;
    if (score <= 0 && chosen.length) break;
    // Precision over recall: once we have something, skip sections far below the best match.
    if (pickedTop && top > 0 && score < top * 0.25) break;
    const n = s.text.length;
    // The best match is always included (the budget stage truncates it if needed); the rest must fit.
    if (pickedTop && used + n > budget) continue;
    chosen.push(s);
    used += n;
    pickedTop = true;
    if (used >= budget) break;
  }
  chosen.sort((a, b) => a.index - b.index);
  return { sections: chosen, matched: top > 0 };
}

export function renderOutline(sections: Section[], shown: Set<number>, limit = 40): string {
  const titles = sections.filter((s) => !shown.has(s.index) && s.level > 0).map((s) => s.title);
  if (!titles.length) return "";
  const extra = titles.length > limit ? ` (+${titles.length - limit} more)` : "";
  return "Sections not shown: " + titles.slice(0, limit).join(" · ") + extra;
}

export function joinSections(chosen: Section[]): string {
  return (
    chosen
      .map((s) => s.text)
      .join("\n\n")
      .trim() + "\n"
  );
}
