/**
 * Fast paths for sources a coding agent hits constantly that have a documented, cleaner-than-HTML
 * representation: GitHub (raw files, READMEs, issues, gists), PyPI, npm, StackOverflow, arXiv, llms.txt.
 * These use the sites' public APIs under their API terms. Each returns a `Fetched` or null to fall through.
 */

import type { Fetched, HttpLike } from "./types.js";
import { htmlSnippetToMarkdown } from "./extract.js";

const CODE_EXT: Record<string, string> = {
  py: "python",
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  ts: "typescript",
  mts: "typescript",
  tsx: "tsx",
  jsx: "jsx",
  rs: "rust",
  go: "go",
  java: "java",
  kt: "kotlin",
  swift: "swift",
  rb: "ruby",
  php: "php",
  c: "c",
  h: "c",
  cpp: "cpp",
  cc: "cpp",
  hpp: "cpp",
  cs: "csharp",
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  yml: "yaml",
  yaml: "yaml",
  toml: "toml",
  json: "json",
  xml: "xml",
  html: "html",
  css: "css",
  scss: "scss",
  sql: "sql",
  proto: "protobuf",
  tf: "hcl",
  dockerfile: "dockerfile",
  lua: "lua",
  ex: "elixir",
  exs: "elixir",
  scala: "scala",
  hs: "haskell",
  ml: "ocaml",
  clj: "clojure",
  dart: "dart",
  r: "r",
  jl: "julia",
  zig: "zig",
  nim: "nim",
  vue: "vue",
  svelte: "svelte",
  ini: "ini",
  cfg: "ini",
  mk: "makefile",
  makefile: "makefile",
  gradle: "groovy",
  ps1: "powershell",
};
const TEXT_EXT = new Set(["md", "mdx", "markdown", "rst", "txt", "adoc", "org"]);

/**
 * Documented public API endpoints we use; robots.txt governs crawling, API terms govern these.
 * Hosts that serve both pages and an API (Wikipedia, MDN, crates.io, PyPI) are matched by path.
 */
export const API_ENDPOINTS: Array<[host: string, pathPrefix: string]> = [
  ["api.github.com", "/"],
  ["raw.githubusercontent.com", "/"],
  ["gist.githubusercontent.com", "/"],
  ["registry.npmjs.org", "/"],
  ["api.stackexchange.com", "/"],
  ["export.arxiv.org", "/"],
  ["pypi.org", "/pypi/"],
  ["crates.io", "/api/"],
  ["developer.mozilla.org", "/api/"],
  ["en.wikipedia.org", "/w/api.php"],
];

export function isApiUrl(url: string): boolean {
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase();
    return API_ENDPOINTS.some(([h, p]) => host === h && u.pathname.startsWith(p));
  } catch {
    return false;
  }
}

function ghHeaders(accept: string): Record<string, string> {
  const h: Record<string, string> = { Accept: accept };
  const tok = process.env.GITHUB_TOKEN;
  if (tok) h.Authorization = `Bearer ${tok}`;
  return h;
}

/** Return (kind, body): markdown-ish text verbatim, code fenced with a language. */
export function wrapFile(name: string, text: string): ["markdown", string] {
  const ext = name.includes(".") ? name.split(".").pop()!.toLowerCase() : name.toLowerCase();
  if (TEXT_EXT.has(ext)) return ["markdown", text];
  const lang = CODE_EXT[ext] ?? "";
  let fence = "```";
  while (text.includes(fence)) fence += "`";
  return ["markdown", `${fence}${lang}\n${text.replace(/\s+$/, "")}\n${fence}\n`];
}

/** A fast-path result: markdown we produced ourselves from an API, attributed to `source`. */
function markdownResult(url: string, body: string, source: string): Fetched {
  return { url, finalUrl: url, kind: "markdown", body, source, status: 200, contentType: "text/markdown", headers: {} };
}

async function getOk(http: HttpLike, url: string, headers?: Record<string, string>) {
  try {
    const r = await http(url, { headers });
    return r.status === 200 ? r : null;
  } catch {
    return null;
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = Record<string, any>;

async function github(url: string, u: URL, http: HttpLike): Promise<Fetched | null> {
  const host = u.hostname.toLowerCase();
  const segs = u.pathname.split("/").filter(Boolean);

  if (host === "raw.githubusercontent.com" || host === "gist.githubusercontent.com") {
    const r = await getOk(http, url);
    if (!r) return null;
    const [, body] = wrapFile(segs[segs.length - 1] ?? "", await r.text());
    return markdownResult(url, body, "github-raw");
  }

  if (host === "gist.github.com" && segs.length >= 2) {
    const r = await getOk(http, `https://api.github.com/gists/${segs[1]}`, ghHeaders("application/vnd.github+json"));
    if (!r) return null;
    const data = (await r.json()) as Json;
    const out = [`# Gist: ${data.description || segs[1]}`];
    for (const [name, f] of Object.entries((data.files ?? {}) as Record<string, Json>)) {
      const [, body] = wrapFile(name, String(f.content ?? ""));
      out.push(`## ${name}\n\n${body}`);
    }
    return markdownResult(url, out.join("\n\n") + "\n", "github-gist");
  }

  if (host !== "github.com" || segs.length < 2) return null;
  const [owner, repo] = segs;

  if (segs.length === 2) {
    const r = await getOk(
      http,
      `https://api.github.com/repos/${owner}/${repo}/readme`,
      ghHeaders("application/vnd.github.raw+json"),
    );
    if (!r) return null;
    const meta = await getOk(
      http,
      `https://api.github.com/repos/${owner}/${repo}`,
      ghHeaders("application/vnd.github+json"),
    );
    let head = "";
    if (meta) {
      const m = (await meta.json()) as Json;
      head =
        `# ${m.full_name}\n\n${m.description ?? ""}\n\n` +
        `Stars: ${m.stargazers_count} · Language: ${m.language} · Default branch: ${m.default_branch} · Updated: ${String(m.pushed_at).slice(0, 10)}\n\n---\n\n`;
    }
    return markdownResult(url, head + (await r.text()), "github-readme");
  }

  if (segs.length >= 4 && (segs[2] === "blob" || segs[2] === "raw")) {
    const raw = `https://raw.githubusercontent.com/${owner}/${repo}/${segs.slice(3).join("/")}`;
    const r = await getOk(http, raw);
    if (!r) return null;
    const [, body] = wrapFile(segs[segs.length - 1], await r.text());
    return markdownResult(url, body, "github-raw");
  }

  if (segs.length >= 4 && segs[2] === "tree") {
    // github.com/o/r/tree/<ref>/<path...> — branch names may contain "/", so try ref boundaries in turn.
    const rest = segs.slice(3);
    for (let refLen = 1; refLen <= Math.min(rest.length, 3); refLen++) {
      const ref = rest.slice(0, refLen).join("/");
      const path = rest.slice(refLen).join("/");
      const r = await getOk(
        http,
        `https://api.github.com/repos/${owner}/${repo}/contents/${path}?ref=${encodeURIComponent(ref)}`,
        ghHeaders("application/vnd.github+json"),
      );
      if (!r) continue;
      const items = (await r.json()) as Json[] | Json;
      if (!Array.isArray(items)) continue; // a file, not a directory
      const dirs = items.filter((i) => i.type === "dir").sort((a, b) => String(a.name).localeCompare(String(b.name)));
      const files = items.filter((i) => i.type !== "dir").sort((a, b) => String(a.name).localeCompare(String(b.name)));
      const lines = [
        `# ${owner}/${repo} — ${path || "/"} @ ${ref}`,
        "",
        ...dirs.map((d) => `- ${d.name}/`),
        ...files.map((f) => `- ${f.name}${f.size ? ` (${f.size} B)` : ""}`),
        "",
        `${items.length} entries. Fetch a file with its blob URL, e.g. https://github.com/${owner}/${repo}/blob/${ref}/${path ? path + "/" : ""}<name>.`,
      ];
      return markdownResult(url, lines.join("\n") + "\n", "github-tree");
    }
    return null;
  }

  if (segs.length >= 3 && segs[2] === "releases") {
    const tag = segs[3] === "tag" ? segs[4] : undefined;
    const api = tag
      ? `https://api.github.com/repos/${owner}/${repo}/releases/tags/${encodeURIComponent(tag)}`
      : `https://api.github.com/repos/${owner}/${repo}/releases?per_page=10`;
    const r = await getOk(http, api, ghHeaders("application/vnd.github+json"));
    if (!r) return null;
    const data = (await r.json()) as Json | Json[];
    const rels = Array.isArray(data) ? data : [data];
    const out = [`# ${owner}/${repo} releases${tag ? ` — ${tag}` : " (latest 10)"}`, ""];
    for (const rel of rels) {
      out.push(
        `## ${rel.name || rel.tag_name} (${rel.tag_name}, ${String(rel.published_at ?? rel.created_at).slice(0, 10)}${rel.prerelease ? ", pre-release" : ""})`,
        "",
        String(rel.body ?? "(no notes)").trim(),
        "",
      );
    }
    return markdownResult(url, out.join("\n") + "\n", "github-releases");
  }

  if (segs.length >= 4 && (segs[2] === "issues" || segs[2] === "pull") && /^\d+$/.test(segs[3])) {
    const num = segs[3];
    const r = await getOk(
      http,
      `https://api.github.com/repos/${owner}/${repo}/issues/${num}`,
      ghHeaders("application/vnd.github+json"),
    );
    if (!r) return null;
    const issue = (await r.json()) as Json;
    const out = [
      `# ${issue.title} (#${num})`,
      `${owner}/${repo} · ${issue.state} · by ${issue.user?.login} · ${String(issue.created_at).slice(0, 10)} · ${issue.comments ?? 0} comments`,
      "",
      issue.body || "(no description)",
    ];
    const c = await getOk(
      http,
      `https://api.github.com/repos/${owner}/${repo}/issues/${num}/comments?per_page=15`,
      ghHeaders("application/vnd.github+json"),
    );
    if (c) {
      for (const cm of (await c.json()) as Json[]) {
        out.push(`\n---\n**${cm.user?.login}** (${String(cm.created_at).slice(0, 10)}):\n\n${cm.body ?? ""}`);
      }
    }
    return markdownResult(url, out.join("\n") + "\n", "github-issue");
  }
  return null;
}

async function pypi(url: string, u: URL, http: HttpLike): Promise<Fetched | null> {
  const m = /^\/(?:project|pypi)\/([^/]+)\/?/.exec(u.pathname);
  if (!m) return null;
  const r = await getOk(http, `https://pypi.org/pypi/${m[1]}/json`, { Accept: "application/json" });
  if (!r) return null;
  const info = (((await r.json()) as Json).info ?? {}) as Json;
  const urls = (info.project_urls ?? {}) as Record<string, string>;
  const head = [
    `# ${info.name} ${info.version}`,
    info.summary ?? "",
    "",
    `Requires: ${info.requires_python || "?"} · License: ${info.license || "?"}`,
    "Links: " +
      Object.entries(urls)
        .slice(0, 6)
        .map(([k, v]) => `${k}: ${v}`)
        .join(" · "),
    "",
    "---",
    "",
  ];
  let desc = String(info.description ?? "");
  if (String(info.description_content_type ?? "").startsWith("text/x-rst"))
    desc = "(README is reStructuredText)\n\n" + desc;
  return markdownResult(url, head.join("\n") + desc + "\n", "pypi");
}

async function npm(url: string, u: URL, http: HttpLike): Promise<Fetched | null> {
  const m = /^\/package\/((?:@[^/]+\/)?[^/]+)/.exec(u.pathname);
  if (!m) return null;
  const r = await getOk(http, `https://registry.npmjs.org/${m[1]}`, { Accept: "application/json" });
  if (!r) return null;
  const data = (await r.json()) as Json;
  const latest = data["dist-tags"]?.latest ?? "";
  const repo = typeof data.repository === "object" ? data.repository?.url : data.repository;
  const head = [
    `# ${data.name} ${latest}`,
    data.description ?? "",
    "",
    `Homepage: ${data.homepage || "?"} · Repo: ${repo || "?"}`,
    "",
    "---",
    "",
  ];
  return markdownResult(url, head.join("\n") + (data.readme || "(no README)") + "\n", "npm");
}

async function stackoverflow(url: string, u: URL, http: HttpLike): Promise<Fetched | null> {
  const m = /^\/(?:questions|q)\/(\d+)/.exec(u.pathname);
  if (!m) return null;
  const base = "https://api.stackexchange.com/2.3";
  const q = await getOk(http, `${base}/questions/${m[1]}?site=stackoverflow&filter=withbody`);
  if (!q) return null;
  const items = (((await q.json()) as Json).items ?? []) as Json[];
  if (!items.length) return null;
  const qi = items[0];
  const who = (o: Json | undefined) => (o?.display_name ? String(o.display_name) : "unknown");
  const out = [
    `# ${htmlSnippetToMarkdown(String(qi.title ?? "")).trim()}`,
    `Asked by ${who(qi.owner as Json)} · score ${qi.score} · ${qi.answer_count} answers · tags: ${(qi.tags ?? []).join(", ")}`,
    "",
    htmlSnippetToMarkdown(String(qi.body ?? "")),
  ];
  const a = await getOk(
    http,
    `${base}/questions/${m[1]}/answers?site=stackoverflow&order=desc&sort=votes&filter=withbody&pagesize=4`,
  );
  if (a) {
    const answers = (((await a.json()) as Json).items ?? []) as Json[];
    answers.sort((x, y) => Number(!!y.is_accepted) - Number(!!x.is_accepted) || (y.score ?? 0) - (x.score ?? 0));
    for (const ans of answers) {
      const tag = ans.is_accepted ? "Accepted answer" : "Answer";
      const link = `https://stackoverflow.com/a/${ans.answer_id}`;
      out.push(
        `\n---\n## ${tag} by ${who(ans.owner as Json)} (score ${ans.score}) — ${link}\n\n${htmlSnippetToMarkdown(String(ans.body ?? ""))}`,
      );
    }
  }
  out.push(
    "\n---\nContent from Stack Overflow is licensed CC BY-SA 4.0: attribute the authors and link to the posts when reusing it.",
  );
  return markdownResult(url, out.join("\n") + "\n", "stackoverflow");
}

/** Cheap URL rewrites that yield a better representation of the same content. */
export function rewriteUrl(url: string): string {
  const u = new URL(url);
  if (u.hostname === "arxiv.org" || u.hostname === "www.arxiv.org") {
    const m = /^\/abs\/([\w.]+?)(?:v\d+)?\/?$/.exec(u.pathname);
    if (m) return `https://arxiv.org/abs/${m[1]}`;
  }
  return url;
}

export async function resolveFastPath(url: string, http: HttpLike): Promise<Fetched | null> {
  const u = new URL(url);
  const host = u.hostname.toLowerCase();
  try {
    if (host.endsWith("github.com") || host.endsWith("githubusercontent.com")) return await github(url, u, http);
    if (host === "pypi.org" || host === "www.pypi.org") return await pypi(url, u, http);
    if (host === "www.npmjs.com" || host === "npmjs.com") return await npm(url, u, http);
    if (host === "stackoverflow.com" || host === "www.stackoverflow.com") return await stackoverflow(url, u, http);
  } catch {
    return null; // fast paths are best-effort
  }
  return null;
}

const llmsCache = new Map<string, { text: string | null; at: number }>();
const LLMS_TTL_MS = 60 * 60_000;

/** Return the site's /llms.txt content if it exists (cached per origin for an hour, not forever). */
export async function llmsTxt(url: string, http: HttpLike): Promise<string | null> {
  const u = new URL(url);
  const origin = `${u.protocol}//${u.host}`;
  const hit = llmsCache.get(origin);
  if (hit && Date.now() - hit.at < LLMS_TTL_MS) return hit.text;
  let text: string | null = null;
  const r = await getOk(http, `${origin}/llms.txt`, { Accept: "text/plain, text/markdown" });
  if (r) {
    const ct = r.headers["content-type"] ?? "";
    const body = await r.text();
    if (!ct.includes("html") && !/<html/i.test(body.slice(0, 500)) && body.trim().length > 50) text = body;
  }
  if (llmsCache.size > 500) llmsCache.clear();
  llmsCache.set(origin, { text, at: Date.now() });
  return text;
}
