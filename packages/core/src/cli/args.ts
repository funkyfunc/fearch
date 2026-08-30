/** Tiny `--flag value` / `--flag` parser for the subcommands (server flags are parsed in config.ts). */

export type Flags = Record<string, string | true>;

export function parseArgs(argv: string[]): { positional: string[]; flags: Flags } {
  const positional: string[] = [];
  const flags: Flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) {
      positional.push(a);
      continue;
    }
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      flags[a.slice(2)] = next;
      i++;
    } else flags[a.slice(2)] = true;
  }
  return { positional, flags };
}

export const num = (v: string | true | undefined, fallback: number): number =>
  typeof v === "string" && Number.isFinite(Number(v)) ? Number(v) : fallback;
export const str = (v: string | true | undefined): string | undefined => (typeof v === "string" ? v : undefined);
