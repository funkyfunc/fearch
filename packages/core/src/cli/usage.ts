export function usage(): string {
  return `usage: fearch [server flags] [command]

server flags (put these in your MCP config's args):
  --robots default|strict|minimal|off      robots.txt: which groups apply, or not consulted at all (default: default)
  --browser headless|headed|extension|off  bundled headless Chromium (default), your installed Chrome in a window, your own
                                           Chrome via the fearch bridge extension (no automation signals; run
                                           \`fearch extension install\` once), or none
  --handoff                                challenges are handed to you in the window, never solved
                                           (implies --browser headed; on by default with extension)
  --incognito                              extension only: open pages in an incognito window (needs “Allow in Incognito”)
  --engines google,bing,duckduckgo         engine result pages in preference order
                                           (default: duckduckgo; google,duckduckgo with --robots off --handoff)
  --session                                send cookies from the tool's browser profile to ordinary pages (headed only)
  --identity header|none                   how the browser names the tool (default: header = From/X-Agent headers)
  --exa                                    add Exa's keyless hosted search (mcp.exa.ai) as the fallback after the engines;
                                           off by default because queries are logged by a third party
  --search-mode all|first-party|off        all providers, only the sites' own APIs, or no search tool
  --allow-domains a,b  --deny-domains c    host lists (subdomains included)
  --audit-log stderr|off|<file>            one JSON line per request
  --log-level debug|info|warn|error        stderr verbosity
  --log-file <file>                        also append every log and audit line to a file (for sharing a debug run)
  --cache-dir <dir>

commands (same flags apply; add --json for machine-readable output):
  (none)                                   start the MCP server (stdio)
  fetch <url> [--mode read|focus|section|pattern|raw] [--query q] [--max-chars N] [--cursor c] [--links] [--archive]
  search <query> [--kind web|code|qa|packages|docs|papers|community] [--site domain] [--recency d|w|m|y] [--n N] [--fetch-top N]
  doctor                                   check configuration, providers, browser, and network
  extension install|status|path            set up the fearch bridge extension in your Chrome (one-time), check it, or print its folder
  --version                                print the version

When a person runs a command, the audit log is off and only warnings are printed unless --audit-log /
--log-level say otherwise; the MCP server keeps its defaults (audit to stderr, info).
Exit codes: 0 ok · 1 refused (a Diagnosis explains why) · 2 failed (network, usage, no results).
`;
}
