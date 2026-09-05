/** `fearch doctor` — the effective configuration plus one real request through each tier. */

import type { App } from "../app.js";
import { ExtensionRenderer } from "../fetch/extension.js";

const NODE_MIN = [22, 5] as const;

type Check = { status: "ok" | "warn" | "FAIL"; label: string; detail: string };

export async function doctor(app: App, opts: { json?: boolean } = {}): Promise<number> {
  const s = app.settings;
  const checks: Check[] = [];
  const ok = (label: string, detail: string) => checks.push({ status: "ok", label, detail });
  const warn = (label: string, detail: string) => checks.push({ status: "warn", label, detail });
  const fail = (label: string, detail: string) => checks.push({ status: "FAIL", label, detail });

  const [major, minor] = process.versions.node.split(".").map(Number);
  const nodeOk = major > NODE_MIN[0] || (major === NODE_MIN[0] && minor >= NODE_MIN[1]);
  (nodeOk ? ok : fail)("node", `${process.version} (needs ≥${NODE_MIN.join(".")} for node:sqlite)`);
  ok("user-agent", s.userAgent);
  ok("robots.txt", `honoured, policy=${s.robotsPolicy} (Crawl-delay honoured)`);
  ok("cache", s.noCache ? "disabled (--no-cache)" : `${s.cacheDir}/cache-v2.sqlite`);
  ok("audit log", s.auditLog);
  const proxy = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy;
  ok("proxy", proxy || "none (set HTTPS_PROXY for a corporate egress proxy)");
  if (s.allowDomains.length) ok("allow list", s.allowDomains.join(", "));
  if (s.denyDomains.length) ok("deny list", s.denyDomains.join(", "));
  const providers = app.search.describe();
  (s.searchMode !== "off" && /\(none\)/.test(providers) ? warn : ok)("search providers", providers);

  // The network, and that the honest UA reaches the other end.
  try {
    const r = await app.fetcher.http("doctor")("https://httpbin.org/user-agent", {});
    const ua = ((await r.json()) as { "user-agent"?: string })["user-agent"] ?? "";
    if (ua.includes("fearch/")) ok("network", `reached httpbin.org; server saw UA "${ua}"`);
    else warn("network", `httpbin.org saw an unexpected UA: ${ua}`);
  } catch (e) {
    fail("network", `could not reach httpbin.org: ${(e as Error).message}`);
  }

  // One real search, never from the cache: doctor checks the engines, not yesterday's answer.
  if (s.searchMode === "off") ok("search", "disabled (--search off); the fetch tool still works");
  else {
    try {
      const o = await app.search.search({ query: "fearch doctor check", maxResults: 2 }, { noCache: true });
      ok("search", `${o.results.length} result(s) via ${o.providers.map((p) => p.name).join("+")}`);
    } catch (e) {
      warn("search", (e as Error).message);
      if (s.logLevel === "debug") process.stderr.write(`${(e as Error).stack}\n`);
    }
  }

  // The extension bridge (used by auto and extension modes).
  if (app.browser instanceof ExtensionRenderer) {
    const bridge = app.browser.bridge;
    try {
      const port = await bridge.start();
      if (await bridge.waitForConnection(3_000)) {
        const info = bridge.extensionInfo();
        const incognito = info?.incognitoAllowed
          ? "allowed"
          : s.incognito
            ? 'not allowed in Chrome — --incognito will fail until "Allow in Incognito" is enabled at chrome://extensions'
            : 'not allowed in Chrome ("Allow in Incognito" at chrome://extensions enables --incognito)';
        ok("extension", `fearch bridge ${info?.version} connected on port ${port}; incognito ${incognito}`);
      } else if (s.browser === "extension")
        warn("extension", `not connected on port ${port} — run \`fearch extension install\`; falling back meanwhile`);
      else if (process.platform === "darwin" && s.canSurface && s.searchMode !== "off")
        warn(
          "extension",
          `not connected — on macOS, Chrome brings itself forward whenever it is driven over the DevTools protocol (a Chromium bug, worse since Chrome 146), so engine searches through the background window will interrupt you; \`fearch extension install\` routes them through your own Chrome, which never does`,
        );
      else
        ok("extension", `not connected (optional — \`fearch extension install\` routes pages through your own Chrome)`);
    } catch (e) {
      warn("extension", (e as Error).message);
    }
  }
  if (s.browser === "auto")
    ok(
      "escalation",
      s.canSurface
        ? `a challenge opens in a visible window for you (handoff ${s.handoff ? "on" : "off"})`
        : "no display detected — challenges stay final (graceful headless behaviour)",
    );

  // The browser tier.
  if (s.browser === "off") warn("browser", "off (--browser off)");
  else {
    try {
      const r = await app.browser.render("https://example.com/");
      // Say what the tier that actually rendered sends. The bridge extension is the person's own
      // Chrome and adds no headers at all; only the Playwright tiers carry From/X-Agent.
      const identity =
        app.browser.browserChannel === "extension"
          ? `none — your own Chrome, no identifying headers; ${s.incognito ? "incognito, your logins stay out" : "your logins ride along (--incognito to keep them out)"}`
          : "From/X-Agent headers name the tool";
      ok(
        "browser",
        `${s.browser} ${app.browser.browserChannel} rendered example.com (${r.html.length} chars); identity=${identity}; UA: ${app.browser.browserUserAgent}`,
      );
    } catch (e) {
      fail("browser", (e as Error).message);
    }
  }

  const failed = checks.some((c) => c.status === "FAIL");
  if (opts.json) {
    process.stdout.write(JSON.stringify({ ok: !failed, version: s.version, checks }, null, 2) + "\n");
  } else {
    const lines = [`fearch ${s.version} doctor`, ""];
    for (const c of checks)
      lines.push(`  [${c.status}]${" ".repeat(Math.max(1, 5 - c.status.length))}${c.label}: ${c.detail}`);
    process.stdout.write(lines.join("\n") + "\n");
  }
  return failed ? 1 : 0;
}
