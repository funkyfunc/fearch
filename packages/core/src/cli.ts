#!/usr/bin/env node
/** stdio entrypoint. stdout carries only JSON-RPC; everything else goes to stderr. */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { settingsFromArgs } from "./config.js";
import { buildServer, createState } from "./server.js";
const { settings, rest, overrides } = settingsFromArgs(process.argv.slice(2));

async function main(): Promise<void> {
  const sub = rest[0];
  if (sub === "--version" || sub === "-v") {
    process.stdout.write(`fearch ${settings.version}\n`);
    return;
  }
  if (sub === "--help" || sub === "-h") {
    const { usage } = await import("./commands.js");
    process.stdout.write(usage());
    return;
  }
  if (sub && !sub.startsWith("-")) {
    // A person (or a script) is running a command: be quiet unless told otherwise. The audit log and
    // info-level chatter are for the long-running server.
    const cliSettings = {
      ...settings,
      auditLog: overrides.FEARCH_AUDIT_LOG ?? process.env.FEARCH_AUDIT_LOG ?? "off",
      logLevel: (overrides.FEARCH_LOG_LEVEL ?? process.env.FEARCH_LOG_LEVEL ?? "warn") as typeof settings.logLevel,
    };
    const { runCommand } = await import("./commands.js");
    process.exit(await runCommand(rest, cliSettings));
  }
  if (rest.length) {
    process.stderr.write(`fearch: unknown argument ${rest[0]}\n`);
    process.exit(2);
  }
  const state = createState(settings);
  const server = buildServer(state);
  const { audit } = state;
  audit.log("info", `fearch ${settings.version} starting (stdio)${Object.keys(overrides).length ? ` with flags ${Object.entries(overrides).map(([k, v]) => `${k}=${v}`).join(" ")}` : ""}`);
  audit.log("info", `User-Agent: ${settings.userAgent}`);
  audit.log("info", "Site operators can block this agent with `User-agent: fearch` in robots.txt; the URL in the UA explains what it is.");
  audit.log(
    "info",
    `robots.txt: ${settings.ignoreRobots ? "not consulted (FEARCH_ROBOTS_POLICY=off)" : `honoured, policy=${settings.robotsPolicy} (${settings.robotsPolicy === "strict" ? "incl. training-crawler opt-outs" : settings.robotsPolicy === "minimal" ? "* and own token only" : "* , own token, and user-initiated agent tokens Claude-User/ChatGPT-User"})`}`,
  );
  audit.log("info", `search providers — ${state.search.describe()}`);
  audit.log("info", `browser tier: ${settings.browser === "off" ? "off" : settings.browser === "headed" ? `headed — your installed Chrome in a visible window; handoff=${settings.handoff ? "on" : "off"}; session=${settings.browserSession ? "on" : "off"}` : "headless — bundled Chromium, self-identified, used for engine pages and once when the plain client gets a JS shell or is refused"}`);
  if (settings.allowDomains.length) audit.log("info", `allow list: ${settings.allowDomains.join(", ")}`);
  if (settings.denyDomains.length) audit.log("info", `deny list: ${settings.denyDomains.join(", ")}`);

  const transport = new StdioServerTransport();
  await server.connect(transport);
  const shutdown = async () => {
    await server.close().catch(() => {});
    await state.browser.close();
    state.cache.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((e) => {
  process.stderr.write(`FATAL fearch: ${(e as Error).stack ?? e}\n`);
  process.exit(1);
});
