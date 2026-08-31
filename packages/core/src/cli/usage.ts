export function usage(): string {
  return `usage: fearch [server flags] [command]

server flags (put these in your MCP config's args):
  --browser headless|headed|extension|off  who renders pages: bundled headless Chromium (default), your
                                           installed Chrome in a visible window, your own Chrome via the
                                           fearch bridge extension (run \`fearch extension install\` once),
                                           or none. With a visible browser (headed or extension) a person
                                           is present: challenges are handed to you, never solved, and
                                           Google joins DuckDuckGo as your own browsing.
  --robots default|strict|off              robots.txt for the tool's own fetching: honour user-initiated
                                           agent opt-outs (default), also honour training-crawler opt-outs
                                           (strict), or don't consult it (off — the user-agent posture)
  --engines google,bing,duckduckgo         engine result pages in preference order
                                           (default: duckduckgo; google,duckduckgo with a visible browser)
  --allow-domains a,b  --deny-domains c    host lists (subdomains included)

Everything else is an environment variable (FEARCH_*) — escape hatches, not the interface; see the
README's configuration reference.

commands (same flags apply; add --json for machine-readable output):
  (none)                                   start the MCP server (stdio)
  fetch <url> [--mode read|focus|section|pattern|raw] [--query q] [--max-chars N] [--cursor c] [--links] [--archive]
  search <query> [--kind web|code|qa|packages|docs|papers|community] [--site domain] [--recency d|w|m|y] [--n N] [--fetch-top N]
  doctor                                   check configuration, providers, browser, and network
  extension install|status|path            set up the fearch bridge extension in your Chrome (one-time), check it, or print its folder
  --version                                print the version

When a person runs a command, the audit log is off and only warnings are printed unless FEARCH_AUDIT_LOG /
FEARCH_LOG_LEVEL say otherwise; the MCP server keeps its defaults (audit to stderr, info).
Exit codes: 0 ok · 1 refused (a Diagnosis explains why) · 2 failed (network, usage, no results).
`;
}
