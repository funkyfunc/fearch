/**
 * CLI twin of the MCP tools, for humans debugging the server:
 *   fearch fetch <url> [--mode read|focus|section|pattern|raw] [--query ..] [--max-chars N] [--cursor c] [--links] [--archive]
 *   fearch search <query> [--kind web|code|qa|packages|docs] [--site d] [--recency d|w|m|y] [--n N] [--fetch-top N]
 *   fearch doctor
 * Prints exactly what the tools would return. Everything goes to stdout here (no MCP framing).
 */

import { createState, renderDoc, type AppState } from "./server.js";
import type { Settings } from "./config.js";
import { cpSync, existsSync, mkdirSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { ExtensionBridge, ExtensionRenderer, EXTENSION_ID } from "./fetch/extension.js";
import { renderResults } from "./search/render.js";
import { SearchError } from "./search/provider.js";
import { renderDiagnosis } from "./fetch/diagnose.js";
import { DiagnosedError } from "./fetch/pipeline.js";
import { applyBudget } from "./fetch/budget.js";
import { applyLinkMode } from "./fetch/render.js";
import { focusSections, joinSections, splitSections } from "./fetch/sections.js";

function parseArgs(argv: string[]): { positional: string[]; flags: Record<string, string | true> } {
  const positional: string[] = [];
  const flags: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags[key] = next;
        i++;
      } else flags[key] = true;
    } else positional.push(a);
  }
  return { positional, flags };
}

const num = (v: string | true | undefined, def?: number) => (typeof v === "string" && Number.isFinite(Number(v)) ? Number(v) : def);
const str = (v: string | true | undefined) => (typeof v === "string" ? v : undefined);

export async function runCommand(argv: string[], settings?: Settings): Promise<number> {
  const [cmd, ...rest] = argv;
  const { positional, flags } = parseArgs(rest);
  const json = flags.json === true;
  const emitJson = (o: unknown) => process.stdout.write(JSON.stringify(o, null, 2) + "\n");
  const state = createState(settings);
  try {
    if (cmd === "fetch") {
      const url = positional[0];
      if (!url) return usageExit();
      try {
        const mode = (str(flags.mode) ?? (flags.raw === true ? "raw" : "read")) as "read" | "focus" | "section" | "pattern" | "raw";
        const doc = await state.fetcher.fetch(url, { raw: mode === "raw", via: flags.archive === true ? "archive" : undefined });
        const text = renderDoc(doc, {
          mode,
          query: str(flags.query),
          contextChars: num(flags["context-chars"], 200),
          maxChars: num(flags["max-chars"], state.settings.maxChars)!,
          cursor: str(flags.cursor),
          includeLinks: flags.links === true,
        });
        if (json) {
          emitJson({ ok: true, url: doc.url, finalUrl: doc.finalUrl, title: doc.title, source: doc.source, robots: doc.robots, licence: doc.licence, updated: doc.updated ?? null, cached: doc.cached, mode, text });
        } else process.stdout.write(text);
        return 0;
      } catch (e) {
        if (e instanceof DiagnosedError) {
          if (json) emitJson({ ok: false, url, error: { ...e.diagnosis } });
          else process.stdout.write(`Fetch refused or failed for ${url}\n${renderDiagnosis(e.diagnosis)}\n`);
          return 1;
        }
        if (e instanceof Error && ["FetchError", "BlockedURL", "BudgetExceeded", "SectionNotFound", "BadRequest"].includes(e.name)) {
          if (json) emitJson({ ok: false, url, error: { kind: e.name, message: e.message } });
          else process.stdout.write(`Fetch failed for ${url}: ${e.message}\n`);
          return 2;
        }
        throw e;
      }
    }
    if (cmd === "search") {
      const query = positional.join(" ");
      if (!query) return usageExit();
      const kind = str(flags.kind) as "web" | "code" | "qa" | "packages" | "docs" | "papers" | "community" | undefined;
      let outcome;
      try {
        outcome = await state.search.search({ query, maxResults: num(flags.n, 8)!, kind, site: str(flags.site), recency: str(flags.recency) as "d" | "w" | "m" | "y" | undefined });
      } catch (e) {
        if (e instanceof SearchError) {
          if (json) emitJson({ ok: false, query, error: { kind: "SearchError", message: e.message } });
          else process.stdout.write(`Search failed: ${e.message}\n`);
          return 2;
        }
        throw e;
      }
      const top = num(flags["fetch-top"], 0)!;
      for (const r of outcome.results.slice(0, top)) {
        try {
          const doc = await state.fetcher.fetch(r.url);
          const chosen = focusSections(splitSections(doc.markdown), query, state.settings.excerptChars);
          const { body } = applyLinkMode(joinSections(chosen), false);
          r.excerpt = applyBudget(body, 0, state.settings.excerptChars).text.trim();
        } catch {
          // excerpt is best-effort
        }
      }
      if (json) {
        emitJson({ ok: true, query, providers: outcome.providers.map((p) => p.name), fromCache: outcome.fromCache, fellBackToFederation: outcome.fellBackToFederation, notes: outcome.notes, results: outcome.results });
      } else process.stdout.write(renderResults(query, outcome));
      return 0;
    }
    if (cmd === "extension") {
      return await extensionCommand(state, positional[0] ?? "status", flags);
    }
    if (cmd === "doctor") return await doctor(state); // `await` matters: finally() must not run before doctor finishes
    return usageExit();
  } finally {
    await state.browser.close();
    state.cache.close();
  }
}

export function usage(): string {
  return [
    "usage: fearch [server flags] [command]",
    "",
    "server flags (put these in your MCP config's args):",
    "  --robots default|strict|minimal|off   robots.txt: which groups apply, or not consulted at all (default: default)",
    "  --browser headless|headed|extension|off  bundled headless Chromium (default), your installed Chrome in a window, your own Chrome via",
    "                                         the fearch bridge extension (no automation signals; run `fearch extension install` once), or none",
    "  --handoff                              challenges are handed to you in the window, never solved (implies --browser headed; on by default with extension)",
    "  --incognito                            extension only: open pages in an incognito window (needs “Allow in Incognito”)",
    "  --engines google,bing,duckduckgo       engine result pages in preference order (default: duckduckgo; google,duckduckgo with --robots off --handoff)",
    "  --session                              send cookies from the tool's browser profile to ordinary pages (headed only)",
    "  --identity header|none                 how the browser names the tool (default: header = From/X-Agent headers)",
    "  --exa                                  add Exa's keyless hosted search (mcp.exa.ai) as the fallback after the engines; off by default because queries are logged by a third party",
    "  --search-mode all|first-party|off      all providers, only the sites' own APIs, or no search tool",
    "  --allow-domains a,b  --deny-domains c  host lists (subdomains included)",
    "  --audit-log stderr|off|<file>  --cache-dir <dir>",
    "  --log-level debug|info|warn|error  --log-file <file>   verbosity; --log-file also appends every log and audit line to a file (for sharing a debug run)",
    "",
    "commands (same flags apply; add --json for machine-readable output):",
    "  (none)                              start the MCP server (stdio)",
    "  fetch <url> [--mode read|focus|section|pattern|raw] [--query q] [--max-chars N] [--cursor c] [--links] [--archive] [--json]",
    "  search <query> [--kind web|code|qa|packages|docs|papers|community] [--site domain] [--recency d|w|m|y] [--n N] [--fetch-top N] [--json]",
    "  doctor                              check configuration, providers, browser, and network",
    "  extension install|status|path       set up the fearch bridge extension in your Chrome (one-time), check it, or print its folder",
    "  --version                           print the version",
    "",
    "When run by a person (a command is given), the audit log is off and only warnings are printed unless",
    "--audit-log / --log-level say otherwise; the MCP server keeps its defaults (audit to stderr, info).",
    "Exit codes: 0 ok · 1 refused (a Diagnosis explains why) · 2 failed (network, usage, no results).",
    "",
  ].join("\n");
}
function usageExit(): number {
  process.stdout.write(usage());
  return 1;
}

async function doctor(state: AppState): Promise<number> {
  const s = state.settings;
  const lines: string[] = [];
  const ok = (label: string, detail: string) => lines.push(`  [ok]   ${label}: ${detail}`);
  const warn = (label: string, detail: string) => lines.push(`  [warn] ${label}: ${detail}`);
  const fail = (label: string, detail: string) => lines.push(`  [FAIL] ${label}: ${detail}`);

  lines.push(`fearch ${s.version} doctor`, "");
  ok("node", `${process.version} (needs ≥22.5 for node:sqlite)`);
  ok("user-agent", s.userAgent);
  lines.push(`  ${s.ignoreRobots ? "[warn] robots.txt: not consulted (--robots off — user-agent posture; stamped on every result)" : `[ok]   robots.txt: honoured, policy=${s.robotsPolicy} (Crawl-delay honoured)`}`);
  ok("cache", s.noCache ? "disabled (FEARCH_NO_CACHE)" : `${s.cacheDir}/cache-v2.sqlite`);
  ok("audit log", s.auditLog);
  const proxy = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy;
  lines.push(`  [ok]   proxy: ${proxy ? proxy : "none (set HTTPS_PROXY for a corporate egress proxy)"}`);
  if (s.allowDomains.length) ok("allow list", s.allowDomains.join(", "));
  if (s.denyDomains.length) ok("deny list", s.denyDomains.join(", "));
  lines.push(`  [ok]   search providers: ${state.search.describe()}`);

  // Network: honest UA echo.
  try {
    const r = await state.fetcher.http("doctor")("https://httpbin.org/user-agent", {});
    const ua = ((await r.json()) as { "user-agent"?: string })["user-agent"] ?? "";
    if (ua.includes("fearch/")) ok("network", `reached httpbin.org; server saw UA "${ua}"`);
    else warn("network", `httpbin.org saw an unexpected UA: ${ua}`);
  } catch (e) {
    fail("network", `could not reach httpbin.org: ${(e as Error).message}`);
  }

  // Search: keyless path.
  try {
    const o = await state.search.search({ query: "fearch doctor check", maxResults: 2 });
    ok("search", `${o.results.length} result(s) via ${o.providers.map((p) => p.name).join("+") || "cache"}${o.fellBackToFederation ? " (federation fallback)" : ""}`);
  } catch (e) {
    warn("search", (e as Error).message);
    if (s.logLevel === "debug") process.stderr.write(`${(e as Error).stack}\n`);
  }

  // Browser tier.
  // Extension tier: is the bridge extension actually there?
  if (s.browser === "extension" && state.browser instanceof ExtensionRenderer) {
    const bridge = state.browser.bridge;
    const port = await bridge.start();
    if (await bridge.waitForConnection(3_000)) {
      const info = bridge.extensionInfo();
      ok("extension", `fearch bridge ${info?.version} connected on port ${port}; incognito ${info?.incognitoAllowed ? "allowed" : "not allowed"}${s.incognito && !info?.incognitoAllowed ? " — --incognito will fail until “Allow in Incognito” is enabled" : ""}`);
    } else warn("extension", `not connected on port ${port} — run \`fearch extension install\`; falling back to the headless tier meanwhile`);
  }
  if (s.browser === "off") warn("browser", "off (--browser off)");
  else {
    try {
      const r = await state.browser.render("https://example.com/");
      const id = s.browserIdentity === "none" ? "none (plain Chrome, no identifying headers)" : "header (From/X-Agent name the tool)";
      ok("browser", `${s.browser} ${state.browser.browserChannel} rendered example.com (${r.html.length} chars); identity=${id}; UA: ${state.browser.browserUserAgent.slice(0, 60)}…${s.browser === "headed" ? `; handoff=${s.handoff ? "on" : "off"}; session=${s.browserSession ? "on" : "off"}; profile: ${s.browserStatePath}` : ""}`);
    } catch (e) {
      fail("browser", `${(e as Error).message}`);
    }
  }

  process.stdout.write(lines.join("\n") + "\n");
  return lines.some((l) => l.includes("[FAIL]")) ? 1 : 0;
}


/** Where the bundled extension lives in this package, and where we copy it for a stable "Load unpacked" path. */
export function bundledExtensionDir(): string {
  return fileURLToPath(new URL("../extension/", import.meta.url));
}
/**
 * The folder Chrome should load. From a clone or a normal install that is the bundled folder itself —
 * nothing is copied. Only when the package lives in npm's ephemeral npx cache is it copied to a stable,
 * visible folder (file dialogs cannot show dot-directories).
 */
export function installedExtensionDir(): string {
  const bundled = bundledExtensionDir();
  return /[\\/](_npx|\.npm|npm-cache)[\\/]/.test(bundled) ? join(homedir(), "fearch-extension") : bundled;
}

function copyToClipboard(text: string): boolean {
  try {
    const cmd = platform() === "darwin" ? "pbcopy" : platform() === "win32" ? "clip" : "xclip";
    const args = platform() === "linux" ? ["-selection", "clipboard"] : [];
    const p = execFile(cmd, args, () => {});
    p.stdin?.end(text);
    return true;
  } catch {
    return false;
  }
}

function openExtensionsPage(): void {
  const url = "chrome://extensions/";
  try {
    if (platform() === "darwin") execFile("open", ["-a", "Google Chrome", url], () => {});
    else if (platform() === "win32") execFile("cmd", ["/c", "start", "chrome", url], () => {});
    else execFile("google-chrome", [url], () => {});
  } catch {
    /* best effort */
  }
}

async function extensionCommand(state: AppState, sub: string, flags: Record<string, string | true>): Promise<number> {
  const out = (t: string) => process.stdout.write(t + "\n");
  const dir = installedExtensionDir();
  if (sub === "path") {
    out(dir);
    return 0;
  }
  const bridge = state.browser instanceof ExtensionRenderer ? state.browser.bridge : new ExtensionBridge(state.audit);
  if (sub === "install") {
    if (dir !== bundledExtensionDir()) {
      mkdirSync(dir, { recursive: true });
      cpSync(bundledExtensionDir(), dir, { recursive: true });
    }
    const copied = copyToClipboard(dir);
    const port = await bridge.start();
    out(`fearch bridge extension folder:\n  ${dir}${copied ? "   (path copied to your clipboard)" : ""}\n`);
    out("In Chrome (opening chrome://extensions for you):");
    out("  1. turn on “Developer mode” (top right)");
    out("  2. click “Load unpacked”, press Cmd+Shift+G (macOS) or type in the path box, paste the folder above, and choose it");
    out("  3. optional: in the extension's details, enable “Allow in Incognito” for --incognito");
    out(`\nExpected extension ID: ${EXTENSION_ID}.  Status page: http://127.0.0.1:${port}/setup`);
    openExtensionsPage();
    out("\nWaiting for the extension to connect (up to 3 minutes; Ctrl-C to stop)…");
    const ok = await bridge.waitForConnection(180_000);
    if (ok) {
      const info = bridge.extensionInfo();
      out(`✔ connected — fearch bridge ${info?.version}; incognito ${info?.incognitoAllowed ? "allowed" : "not allowed (optional)"}.`);
      out("Use it with: fearch --browser extension … (add --robots off for Google/Bing, --incognito to keep your profile out of it)");
      await bridge.close();
      return 0;
    }
    out("✘ not connected yet. Finish the steps above and run `fearch extension status`.");
    await bridge.close();
    return 1;
  }
  const port = await bridge.start();
  const wait = typeof flags.wait === "string" ? Number(flags.wait) * 1000 : 5_000;
  const ok = await bridge.waitForConnection(wait);
  const info = bridge.extensionInfo();
  out(ok ? `✔ fearch bridge ${info?.version} connected on port ${port}; incognito ${info?.incognitoAllowed ? "allowed" : "not allowed"}` : `✘ no extension connected on port ${port} within ${Math.round(wait / 1000)} s — installed? run \`fearch extension install\`. Folder: ${existsSync(dir) ? dir : "(not installed)"}`);
  await bridge.close();
  return ok ? 0 : 1;
}
