import { FLAGS, type FlagSpec } from "../config.js";

const WIDTH = 100;
const COL = 40;

function wrap(text: string, indent: number): string {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let line = "";
  for (const w of words) {
    if (line && (line + " " + w).length > WIDTH - indent) {
      lines.push(line);
      line = w;
    } else line = line ? `${line} ${w}` : w;
  }
  if (line) lines.push(line);
  return lines.join("\n" + " ".repeat(indent));
}

function valueHint(f: FlagSpec): string {
  if (f.kind === "bool") return "";
  if (f.kind === "enum") return ` ${f.values!.join("|")}`;
  if (f.kind === "list") return f.values ? ` ${f.values.join(",")}` : " a,b";
  if (f.kind === "int") return " N";
  return f.flag.endsWith("dir") || f.flag.endsWith("log") || f.flag.endsWith("file") ? " path" : " value";
}

function flagLine(f: FlagSpec): string {
  const head = `  --${f.flag}${valueHint(f)}`;
  const pad = head.length >= COL ? "\n" + " ".repeat(COL) : " ".repeat(COL - head.length);
  const dflt = f.default ? ` (default: ${f.default})` : "";
  return head + pad + wrap(f.help + dflt, COL);
}

export function usage(): string {
  const core = FLAGS.filter((f) => !f.tuning)
    .map(flagLine)
    .join("\n");
  const tuning = FLAGS.filter((f) => f.tuning)
    .map(
      (f) =>
        `  --${f.flag}${valueHint(f)}${" ".repeat(Math.max(1, COL - 2 - f.flag.length - valueHint(f).length - 2))}${f.help} (${f.default || "unset"})`,
    )
    .join("\n");
  return `usage: fearch [flags] [command]

Flags go in your MCP config's "args". Booleans take --flag, --flag=false or --no-flag. (Every flag also
answers to an environment variable of the same name, FEARCH_HUMAN_SEARCH=1 for --human-search, for
deployments that cannot pass args; flags win.)

${core}

tuning (real settings nobody should need):
${tuning}

commands (same flags apply; add --json for machine-readable output):
  (none)                                  start the MCP server (stdio)
  fetch <url> [--mode read|focus|section|pattern|raw] [--query q] [--max-chars N] [--cursor c] [--links] [--archive]
  search <query> [--site domain] [--recency d|w|m|y] [--n N] [--fetch-top N] [--raw]
  doctor                                  check configuration, providers, browser, and network
  extension install|status|path           set up the fearch bridge extension in your Chrome (one-time), check it, or print its folder
  clear-profile                           forget the tool-owned browser profile (passed checks, cookies sites set)
  --version                               print the version

When a person runs a command, the audit log is off and only warnings are printed unless --audit-log /
--log-level say otherwise; the MCP server keeps its defaults (audit to stderr, info).
Exit codes: 0 ok · 1 refused (a Diagnosis explains why) · 2 failed (network, usage, no results).
`;
}
