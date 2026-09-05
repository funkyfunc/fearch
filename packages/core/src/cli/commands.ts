/**
 * The CLI twin of the MCP tools: `fearch fetch <url>`, `fearch search <query>`, `doctor`, `extension`.
 * Prints exactly what the tools would return; `--json` prints structured output instead.
 */

import { createApp } from "../app.js";
import { UsageError, type Settings } from "../config.js";
import { describeError, isExpected } from "../errors.js";
import { DiagnosedError } from "../fetch/pipeline.js";
import { READ_MODES, readDocument, type ReadMode } from "../fetch/read.js";
import { attachExcerpts } from "../search/excerpt.js";
import type { Recency } from "../search/provider.js";
import { renderResults } from "../search/render.js";
import { num, parseArgs, str, type Flags } from "./args.js";
import { doctor } from "./doctor.js";
import { extensionCommand } from "./extension.js";

const EXIT_OK = 0;
const EXIT_REFUSED = 1;
const EXIT_FAILED = 2;
const RECENCIES = ["d", "w", "m", "y"] as const;

export async function runCommand(argv: string[], settings: Settings): Promise<number> {
  const [command, ...rest] = argv;
  const { positional, flags } = parseArgs(rest);
  const app = createApp(settings);
  try {
    switch (command) {
      case "fetch":
        if (!positional[0]) throw new UsageError("fetch needs a URL: fearch fetch <url>");
        return await fetchCommand(app, positional[0], flags);
      case "search":
        if (!positional.length) throw new UsageError("search needs a query: fearch search <query>");
        return await searchCommand(app, positional.join(" "), flags);
      case "doctor":
        return await doctor(app, { json: flags.json === true });
      case "extension":
        return await extensionCommand(app, positional[0] ?? "status", flags);
      default:
        throw new UsageError(`unknown command "${command}" (fetch, search, doctor, extension)`);
    }
  } finally {
    await app.close();
  }
}

const emit = (flags: Flags, human: string, json: unknown): void => {
  process.stdout.write(flags.json === true ? JSON.stringify(json, null, 2) + "\n" : human);
};

function oneOf<T extends string>(name: string, v: string | undefined, allowed: readonly T[]): T | undefined {
  if (v === undefined) return undefined;
  if (!(allowed as readonly string[]).includes(v))
    throw new UsageError(`--${name} must be one of ${allowed.join("|")}`);
  return v as T;
}

async function fetchCommand(app: ReturnType<typeof createApp>, url: string, flags: Flags): Promise<number> {
  const mode: ReadMode = oneOf("mode", str(flags.mode), READ_MODES) ?? (flags.raw === true ? "raw" : "read");
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
      recency: oneOf<Recency>("recency", str(flags.recency), RECENCIES),
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
