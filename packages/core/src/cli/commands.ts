/**
 * The CLI twin of the MCP tools: `fearch fetch <url>`, `fearch search <query>`, `doctor`, `extension`.
 * Prints exactly what the tools would return; `--json` prints structured output instead.
 */

import { createApp } from "../app.js";
import type { Settings } from "../config.js";
import { describeError, isExpected } from "../errors.js";
import { DiagnosedError } from "../fetch/pipeline.js";
import { readDocument, type ReadMode } from "../fetch/read.js";
import { attachExcerpts } from "../search/excerpt.js";
import type { Recency } from "../search/provider.js";
import { renderResults } from "../search/render.js";
import { num, parseArgs, str, type Flags } from "./args.js";
import { doctor } from "./doctor.js";
import { extensionCommand } from "./extension.js";
import { usage } from "./usage.js";

const EXIT_OK = 0;
const EXIT_REFUSED = 1;
const EXIT_FAILED = 2;

export async function runCommand(argv: string[], settings: Settings): Promise<number> {
  const [command, ...rest] = argv;
  const { positional, flags } = parseArgs(rest);
  const app = createApp(settings);
  try {
    switch (command) {
      case "fetch":
        return positional[0] ? await fetchCommand(app, positional[0], flags) : usageExit();
      case "search":
        return positional.length ? await searchCommand(app, positional.join(" "), flags) : usageExit();
      case "doctor":
        return await doctor(app);
      case "extension":
        return await extensionCommand(app, positional[0] ?? "status", flags);
      default:
        return usageExit();
    }
  } finally {
    await app.close();
  }
}

function usageExit(): number {
  process.stdout.write(usage());
  return EXIT_REFUSED;
}

const emit = (flags: Flags, human: string, json: unknown): void => {
  process.stdout.write(flags.json === true ? JSON.stringify(json, null, 2) + "\n" : human);
};

async function fetchCommand(app: ReturnType<typeof createApp>, url: string, flags: Flags): Promise<number> {
  const mode = (str(flags.mode) ?? (flags.raw === true ? "raw" : "read")) as ReadMode;
  try {
    const doc = await app.fetcher.fetch(url, {
      raw: mode === "raw",
      via: flags.archive === true ? "archive" : undefined,
    });
    const text = readDocument(doc, {
      mode,
      query: str(flags.query),
      contextChars: num(flags["context-chars"], 200),
      maxChars: num(flags["max-chars"], app.settings.maxChars),
      cursor: str(flags.cursor),
      includeLinks: flags.links === true,
    });
    const { markdown: _, ...meta } = doc;
    emit(flags, text, { ok: true, ...meta, mode, text });
    return EXIT_OK;
  } catch (e) {
    if (!isExpected(e)) throw e;
    const error = e instanceof DiagnosedError ? e.diagnosis : { kind: e.name, message: e.message };
    emit(flags, `${e instanceof DiagnosedError ? "" : "Fetch failed for " + url + ": "}${describeError(url, e)}\n`, {
      ok: false,
      url,
      error,
    });
    return e instanceof DiagnosedError ? EXIT_REFUSED : EXIT_FAILED;
  }
}

async function searchCommand(app: ReturnType<typeof createApp>, query: string, flags: Flags): Promise<number> {
  try {
    const outcome = await app.search.search({
      query,
      maxResults: num(flags.n, 8),
      site: str(flags.site),
      recency: str(flags.recency) as Recency | undefined,
    });
    await attachExcerpts(app, outcome.results, query, num(flags["fetch-top"], 0));
    const { providers, ...rest } = outcome;
    emit(flags, renderResults(query, outcome), { ok: true, query, providers: providers.map((p) => p.name), ...rest });
    return EXIT_OK;
  } catch (e) {
    if (!isExpected(e)) throw e;
    emit(flags, `Search failed: ${e.message}\n`, { ok: false, query, error: { kind: e.name, message: e.message } });
    return EXIT_FAILED;
  }
}
