#!/usr/bin/env node
/**
 * Entry point. With a command (`fetch`, `search`, `doctor`, `extension`) it runs that and exits;
 * with none it starts the MCP server on stdio, where stdout carries only JSON-RPC and everything else
 * goes to stderr.
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createApp } from "./app.js";
import { settingsFromArgs, type Settings } from "./config.js";
import { buildServer } from "./server.js";

async function main(): Promise<void> {
  const { settings, rest, overrides } = settingsFromArgs(process.argv.slice(2));
  const [command] = rest;

  if (command === "--version" || command === "-v") return void process.stdout.write(`fearch ${settings.version}\n`);
  if (command === "--help" || command === "-h") {
    const { usage } = await import("./cli/usage.js");
    return void process.stdout.write(usage());
  }
  if (command && !command.startsWith("-")) {
    const { runCommand } = await import("./cli/commands.js");
    process.exit(await runCommand(rest, quietForPeople(settings, overrides)));
  }
  if (rest.length) {
    process.stderr.write(`fearch: unknown argument ${rest[0]}\n`);
    process.exit(2);
  }
  await serve(settings, overrides);
}

/** A person running a command wants the result, not the server's audit stream, unless they asked. */
function quietForPeople(settings: Settings, overrides: Record<string, string>): Settings {
  return {
    ...settings,
    auditLog: overrides.FEARCH_AUDIT_LOG ?? process.env.FEARCH_AUDIT_LOG ?? "off",
    logLevel: (overrides.FEARCH_LOG_LEVEL ?? process.env.FEARCH_LOG_LEVEL ?? "warn") as Settings["logLevel"],
  };
}

async function serve(settings: Settings, overrides: Record<string, string>): Promise<void> {
  const app = createApp(settings);
  const server = buildServer(app);
  const log = (msg: string) => app.audit.log("info", msg);

  const flags = Object.entries(overrides)
    .map(([k, v]) => `${k}=${v}`)
    .join(" ");
  log(`fearch ${settings.version} starting (stdio)${flags ? ` with ${flags}` : ""}`);
  log(`User-Agent: ${settings.userAgent} — operators can block it with \`User-agent: fearch\` in robots.txt`);
  log(
    `robots.txt: ${settings.robotsPolicy === "off" ? "not consulted (--robots off)" : `honoured, policy=${settings.robotsPolicy}`}`,
  );
  log(`search providers — ${app.search.describe()}`);
  log(`browser tier: ${describeBrowser(settings)}`);
  if (settings.allowDomains.length) log(`allow list: ${settings.allowDomains.join(", ")}`);
  if (settings.denyDomains.length) log(`deny list: ${settings.denyDomains.join(", ")}`);

  await server.connect(new StdioServerTransport());
  const shutdown = async () => {
    await server.close().catch(() => {});
    await app.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

function describeBrowser(s: Settings): string {
  switch (s.browser) {
    case "off":
      return "off";
    case "headed":
      return `headed — your installed Chrome in a visible window; handoff=${s.handoff ? "on" : "off"}; session=${s.browserSession ? "on" : "off"}`;
    case "extension":
      return `extension — your own Chrome via the fearch bridge; incognito=${s.incognito ? "on" : "off"}; falls back to headless if not connected`;
    default:
      return "headless — bundled Chromium, self-identified, used for engine pages and once when the plain client gets a JS shell or is refused";
  }
}

main().catch((e) => {
  process.stderr.write(`FATAL fearch: ${(e as Error).stack ?? e}\n`);
  process.exit(1);
});
