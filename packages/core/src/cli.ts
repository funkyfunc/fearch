#!/usr/bin/env node
/**
 * Entry point. With a command (`fetch`, `search`, `doctor`, `extension`) it runs that and exits;
 * with none it starts the MCP server on stdio, where stdout carries only JSON-RPC and everything else
 * goes to stderr.
 */
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { createApp } from "./app.js";
import { flagSpelling, settingsFromArgs, UsageError, type Settings } from "./config.js";
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
  if (rest.length) throw new UsageError(`unknown argument ${rest[0]}`);
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
  const log = (msg: string) => app.audit.log("info", msg);

  const flags = Object.entries(overrides)
    .map(([k, v]) => flagSpelling(k, v))
    .join(" ");
  log(`fearch ${settings.version} starting (stdio)${flags ? ` with ${flags}` : ""}`);
  log(`User-Agent: ${settings.userAgent} — operators can block it with \`User-agent: fearch\` in robots.txt`);
  log(`robots.txt: honoured, policy=${settings.robotsPolicy}`);
  log(`search providers — ${app.search.describe()}`);
  log(`browser tier: ${describeBrowser(settings)}`);
  if (settings.allowDomains.length) log(`allow list: ${settings.allowDomains.join(", ")}`);
  if (settings.denyDomains.length) log(`deny list: ${settings.denyDomains.join(", ")}`);

  // The opening exchange picks the protocol era: a 2025-era `initialize` or a 2026-07-28
  // `server/discover`. Either way one server instance from the factory serves the connection.
  const handle = serveStdio(() => buildServer(app), {
    onerror: (e) => app.audit.log("warn", `stdio: ${e.message}`),
  });
  const shutdown = async () => {
    await handle.close().catch(() => {});
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
    case "extension":
      return `extension — your own Chrome via the fearch bridge; incognito=${s.incognito ? "on" : "off"}; falls back to headless if not connected`;
    case "headless":
      return "headless — bundled Chromium, self-identified, never visible; challenges are final";
    default:
      return s.canSurface
        ? `auto — headless until a challenge, which opens in a window for you${s.handoff ? "" : " (handoff off: it won't)"}; your own Chrome via the extension when connected`
        : "auto — no display here, so effectively headless; challenges are final (graceful)";
  }
}

main().catch((e) => {
  if (e instanceof UsageError) {
    process.stderr.write(`fearch: ${e.message} (see fearch --help)\n`);
    process.exit(2);
  }
  process.stderr.write(`FATAL fearch: ${(e as Error).stack ?? e}\n`);
  process.exit(1);
});
