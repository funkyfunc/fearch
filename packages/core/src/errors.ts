/** One place that turns any error the tools can raise into text for the model or the terminal. */

import { renderDiagnosis } from "./fetch/diagnose.js";
import { BlockedURL } from "./fetch/guard.js";
import { DiagnosedError } from "./fetch/pipeline.js";
import { BadRequest, SectionNotFound } from "./fetch/read.js";
import { FetchError } from "./fetch/transport.js";
import { BudgetExceeded } from "./politeness.js";
import { SearchError } from "./search/provider.js";

/** Errors whose message is meant for the caller, as opposed to a bug. */
export function isExpected(e: unknown): e is Error {
  return (
    e instanceof DiagnosedError ||
    e instanceof BlockedURL ||
    e instanceof FetchError ||
    e instanceof BudgetExceeded ||
    e instanceof SectionNotFound ||
    e instanceof BadRequest ||
    e instanceof SearchError
  );
}

export function describeError(subject: string, e: unknown): string {
  if (e instanceof DiagnosedError) return `Fetch refused or failed for ${subject}\n${renderDiagnosis(e.diagnosis)}`;
  if (isExpected(e)) return e.message;
  return `Unexpected error: ${(e as Error)?.message ?? String(e)}`;
}
