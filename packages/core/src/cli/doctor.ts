/** `fearch doctor` — the effective configuration plus one real request through each tier. */

import type { App } from "../app.js";
import { ExtensionRenderer } from "../fetch/extension.js";

export async function doctor(app: App): Promise<number> {
  const s = app.settings;
  const lines: string[] = [`fearch ${s.version} doctor`, ""];
  const ok = (label: string, detail: string) => lines.push(`  [ok]   ${label}: ${detail}`);
  const warn = (label: string, detail: string) => lines.push(`  [warn] ${label}: ${detail}`);
  const fail = (label: string, detail: string) => lines.push(`  [FAIL] ${label}: ${detail}`);

  ok("node", `${process.version} (needs ≥22.5 for node:sqlite)`);
  ok("user-agent", s.userAgent);
  if (s.robotsPolicy === "off")
    warn("robots.txt", "not consulted (--robots off — user-agent posture; stamped on every result)");
  else ok("robots.txt", `honoured, policy=${s.robotsPolicy} (Crawl-delay honoured)`);
  ok("cache", s.noCache ? "disabled (FEARCH_NO_CACHE=1)" : `${s.cacheDir}/cache-v2.sqlite`);
  ok("audit log", s.auditLog);
  const proxy = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy;
  ok("proxy", proxy || "none (set HTTPS_PROXY for a corporate egress proxy)");
  if (s.allowDomains.length) ok("allow list", s.allowDomains.join(", "));
  if (s.denyDomains.length) ok("deny list", s.denyDomains.join(", "));
  ok("search providers", app.search.describe());

  // The network, and that the honest UA reaches the other end.
  try {
    const r = await app.fetcher.http("doctor")("https://httpbin.org/user-agent", {});
    const ua = ((await r.json()) as { "user-agent"?: string })["user-agent"] ?? "";
    if (ua.includes("fearch/")) ok("network", `reached httpbin.org; server saw UA "${ua}"`);
    else warn("network", `httpbin.org saw an unexpected UA: ${ua}`);
  } catch (e) {
    fail("network", `could not reach httpbin.org: ${(e as Error).message}`);
  }

  // One keyless search.
  try {
    const o = await app.search.search({ query: "fearch doctor check", maxResults: 2 });
    ok(
      "search",
      `${o.results.length} result(s) via ${o.providers.map((p) => p.name).join("+") || "cache"}${o.fellBackToFederation ? " (federation fallback)" : ""}`,
    );
  } catch (e) {
    warn("search", (e as Error).message);
    if (s.logLevel === "debug") process.stderr.write(`${(e as Error).stack}\n`);
  }

  // The extension bridge, when that tier is selected.
  if (app.browser instanceof ExtensionRenderer) {
    const bridge = app.browser.bridge;
    const port = await bridge.start();
    if (await bridge.waitForConnection(3_000)) {
      const info = bridge.extensionInfo();
      const incognito = info?.incognitoAllowed
        ? "allowed"
        : s.incognito
          ? "not allowed — --incognito will fail until “Allow in Incognito” is enabled"
          : "not allowed";
      ok("extension", `fearch bridge ${info?.version} connected on port ${port}; incognito ${incognito}`);
    } else
      warn(
        "extension",
        `not connected on port ${port} — run \`fearch extension install\`; falling back to the headless tier meanwhile`,
      );
  }

  // The browser tier.
  if (s.browser === "off") warn("browser", "off (--browser off)");
  else {
    try {
      const r = await app.browser.render("https://example.com/");
      const identity =
        s.browserIdentity === "none"
          ? "none (plain Chrome, no identifying headers)"
          : "header (From/X-Agent name the tool)";
      const headed =
        s.browser === "headed"
          ? `; handoff=${s.handoff ? "on" : "off"}; session=${s.browserSession ? "on" : "off"}; profile: ${s.browserStatePath}`
          : "";
      ok(
        "browser",
        `${s.browser} ${app.browser.browserChannel} rendered example.com (${r.html.length} chars); identity=${identity}; UA: ${app.browser.browserUserAgent.slice(0, 60)}…${headed}`,
      );
    } catch (e) {
      fail("browser", (e as Error).message);
    }
  }

  process.stdout.write(lines.join("\n") + "\n");
  return lines.some((l) => l.includes("[FAIL]")) ? 1 : 0;
}
