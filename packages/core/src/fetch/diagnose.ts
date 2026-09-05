/**
 * When a fetch does not yield readable content, classify *why* and tell the model what to do next.
 * This replaces the fallback/stealth ladder other servers use: a refusal is final.
 */

import type { Fetched } from "./types.js";
import { fetchedText } from "./types.js";

export type DiagnosisKind =
  | "robots_disallowed"
  | "blocked_or_waf"
  | "captcha_or_challenge"
  | "rate_limited"
  | "payment_required"
  | "login_required"
  | "paywall"
  | "js_required"
  | "not_found"
  | "unavailable_for_legal_reasons"
  | "server_error"
  | "content_signal"
  | "empty";

export interface Diagnosis {
  kind: DiagnosisKind;
  retryable: boolean;
  retryAfterSeconds?: number;
  message: string;
  nextAction: string;
  /** What was tried, in order, e.g. ["direct: HTTP 403", "browser: captcha_or_challenge"]. */
  attempts?: string[];
}

/** Kinds for which a plain-client failure is worth one honest browser attempt. */
export const BROWSER_RETRY_KINDS: ReadonlySet<DiagnosisKind> = new Set([
  "js_required",
  "blocked_or_waf",
  "captcha_or_challenge",
]);

const CHALLENGE_RE =
  /(cf-browser-verification|cf_chl_|Just a moment\.\.\.|Checking your browser|Attention Required! \| Cloudflare|challenge-platform|_Incapsula_Resource|Please enable JavaScript and cookies|DDoS protection by|perimeterx|px-captcha|datadome|hcaptcha\.com|recaptcha\/api\.js|Verify you are human|Access denied)/i;
const LOGIN_RE = /(type=["']password["']|Sign in to continue|Log in to continue|Please log in|Login required)/i;
const PAYWALL_RE = /("isAccessibleForFree"\s*:\s*false|subscribe to continue|subscription required|paywall)/i;

// Turnstile widgets live in a cross-origin iframe: the "Verify you are human" text is invisible to a
// DOM snapshot, and only the loader script or its container betrays them in the outer page.
const TURNSTILE_RE = /(challenges\.cloudflare\.com|cf-turnstile)/i;
/** Titles only an interstitial carries. */
const CHALLENGE_TITLE_RE =
  /<title[^>]*>\s*(Just a moment|Attention Required|Access denied|Verify you are human|Checking your browser|Please wait|Security check|Bot verification|One more step)/i;
const CHALLENGE_PHRASE_RE = /unusual traffic|not a robot|verify you are|are you a human|verify your session/i;
/** An interstitial has almost no visible text; a protected page that loaded fine has an article on it. */
const INTERSTITIAL_MAX_TEXT = 800;

function visibleTextLength(html: string): number {
  return html
    .replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<noscript[\s\S]*?<\/noscript>|<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim().length;
}

/**
 * Is this rendered page a bot challenge / CAPTCHA interstitial (the thing a human, not the tool, may
 * pass)? Decided by the *shape* of the page, not by vendor names: sites behind Cloudflare, DataDome
 * or PerimeterX keep those vendors' scripts on every page that loads fine, and a help article about
 * bot management names them in prose. A challenge is a status that says so, a title only an
 * interstitial carries, Google's /sorry/ URL, or a challenge marker on a page with almost no text.
 */
export function isChallengePage(html: string, status = 200, url = ""): boolean {
  if (status === 429 || /\/sorry\//.test(url) || CHALLENGE_TITLE_RE.test(html)) return true;
  const marked = CHALLENGE_RE.test(html) || CHALLENGE_PHRASE_RE.test(html) || TURNSTILE_RE.test(html);
  if (!marked) return false;
  return visibleTextLength(html) < INTERSTITIAL_MAX_TEXT;
}

const BOOK = "Do not retry with different headers, identities, or proxies — this server never does that.";

/** After the browser tier was also refused: the site has said no to browsers too. */
export function finalizeAfterBrowser(d: Diagnosis, attempts: string[]): Diagnosis {
  return {
    ...d,
    retryable: false,
    attempts,
    message: `${d.message} A real, self-identified browser was also tried and was refused.`,
    nextAction:
      "The site does not serve automated readers, even browsers. Use a different source, an official API, or ask the user to open the page. " +
      BOOK,
  };
}

/**
 * The rendered page is still a bot check. If the person could be asked, the next step is theirs — the
 * same URL, retried once they are there, is the one retry that is correct. Without a handoff the
 * refusal is final as for any other challenge.
 */
export function diagnoseUnpassedChallenge(
  attempts: string[],
  handoffWhere?: string,
  outcome: "timeout" | "declined" | "none" = handoffWhere ? "timeout" : "none",
): Diagnosis {
  if (outcome === "declined") {
    return {
      kind: "captcha_or_challenge",
      retryable: false,
      attempts,
      message: "The site showed a bot check and the user declined to open it.",
      nextAction: "That is the user's answer: use a different source or ask them. " + BOOK,
    };
  }
  if (handoffWhere) {
    return {
      kind: "captcha_or_challenge",
      retryable: true,
      attempts,
      message: `The site showed a bot check; it was opened in ${handoffWhere} but not passed in time.`,
      nextAction:
        "Tell the user the check is waiting for them. When they are at the screen, call fetch again on this same URL — the tab reappears and their pass is remembered. The tool never solves checks itself. " +
        BOOK,
    };
  }
  return finalizeAfterBrowser(
    {
      kind: "captcha_or_challenge",
      retryable: false,
      message: "The page is a bot-challenge interstitial.",
      nextAction: "",
    },
    attempts,
  );
}

export function renderDiagnosis(d: Diagnosis): string {
  const lines = [
    "Diagnosis:",
    `  kind: ${d.kind}`,
    `  retryable: ${d.retryable}` + (d.retryAfterSeconds ? ` (after ${d.retryAfterSeconds}s)` : ""),
    ...(d.attempts?.length ? [`  attempts: ${d.attempts.join(" · ")}`] : []),
    `  message: ${d.message}`,
    `  next: ${d.nextAction}`,
  ];
  return lines.join("\n");
}

export function diagnoseRobots(reason: string): Diagnosis {
  return {
    kind: "robots_disallowed",
    retryable: false,
    message: `robots.txt disallows fetching this URL (${reason}). The page was not requested.`,
    nextAction: "Use a different source (search with site: for an alternative, or an official API/mirror). " + BOOK,
  };
}

export function diagnoseContentSignal(where: string, raw: string): Diagnosis {
  return {
    kind: "content_signal",
    retryable: false,
    message: `The site declares Content-Signal "${raw}" (${where}): ai-input=no means its content must not be fed into an AI model's context. Honouring it; the content was not returned.`,
    nextAction: "Use a different source, or ask the user to open the page themselves. " + BOOK,
  };
}

/** The response was a document with nothing readable in it, or not a document at all. */
export function diagnoseEmpty(message: string): Diagnosis {
  return {
    kind: "empty",
    retryable: false,
    message,
    nextAction:
      "Try mode=raw to see what the server sent, another URL on the site (its docs, its llms.txt), or ask the user.",
  };
}

export function diagnoseBudget(message: string): Diagnosis {
  return {
    kind: "rate_limited",
    retryable: true,
    retryAfterSeconds: 60,
    message,
    nextAction: "Wait, or work with content already fetched.",
  };
}

function parseRetryAfter(v: string | undefined): number | undefined {
  if (!v) return undefined;
  const n = Number(v);
  if (Number.isFinite(n)) return Math.max(1, Math.round(n));
  const t = Date.parse(v);
  return Number.isFinite(t) ? Math.max(1, Math.round((t - Date.now()) / 1000)) : undefined;
}

/** Classify a response that is not usable content. Returns null when the response looks fine. */
export function diagnose(f: Fetched, opts: { isShell?: boolean } = {}): Diagnosis | null {
  const status = f.status;
  const text = f.kind === "html" || f.kind === "text" ? fetchedText(f).slice(0, 30_000) : "";

  if (status === 404 || status === 410) {
    return {
      kind: "not_found",
      retryable: false,
      message: `HTTP ${status}: the page does not exist at this URL.`,
      nextAction: 'Check the URL, search for the current location, or pass via="archive" to read an archived copy.',
    };
  }
  if (status === 451) {
    return {
      kind: "unavailable_for_legal_reasons",
      retryable: false,
      message: "HTTP 451: unavailable for legal reasons.",
      nextAction: "Use a different source. " + BOOK,
    };
  }
  if (status === 402) {
    return {
      kind: "payment_required",
      retryable: false,
      message: "HTTP 402: the site requires payment for automated access (e.g. Cloudflare pay-per-crawl).",
      nextAction: "Respect it; use a different source or the site's official API. " + BOOK,
    };
  }
  if (status === 429 || (status === 503 && !CHALLENGE_RE.test(text))) {
    const ra = parseRetryAfter(f.headers["retry-after"]);
    return {
      kind: "rate_limited",
      retryable: true,
      retryAfterSeconds: ra ?? 60,
      message: `HTTP ${status}: the site asked us to slow down.`,
      nextAction: `Wait ${ra ?? 60}s before fetching this host again; use already-fetched content meanwhile.`,
    };
  }
  if (status === 401 || status === 403 || status === 407 || (status === 503 && CHALLENGE_RE.test(text))) {
    if (CHALLENGE_RE.test(text)) {
      return {
        kind: "captcha_or_challenge",
        retryable: false,
        message: `HTTP ${status}: the site presents a bot challenge (CAPTCHA/JS verification) to automated clients.`,
        nextAction:
          "The site has chosen not to serve automated readers. Use a different source, an official API, or ask the user to open the page. " +
          BOOK,
      };
    }
    if (status === 401 || LOGIN_RE.test(text)) {
      return {
        kind: "login_required",
        retryable: false,
        message: `HTTP ${status}: authentication required.`,
        nextAction: "This server never uses credentials. Ask the user for an authenticated tool or a public mirror.",
      };
    }
    return {
      kind: "blocked_or_waf",
      retryable: false,
      message: `HTTP ${status}: access denied for this client (WAF/bot policy).`,
      nextAction: "The site has declined automated access. Use a different source or the site's official API. " + BOOK,
    };
  }
  if (status >= 500) {
    return {
      kind: "server_error",
      retryable: true,
      retryAfterSeconds: 30,
      message: `HTTP ${status}: the server had an error.`,
      nextAction: "Retry later (once) or use a different source.",
    };
  }
  if (status >= 400) {
    return {
      kind: "blocked_or_waf",
      retryable: false,
      message: `HTTP ${status}.`,
      nextAction: "Use a different source.",
    };
  }
  if (f.kind === "binary") {
    return diagnoseEmpty(`The response is ${f.contentType.split(";")[0] || "binary data"}, not a readable document.`);
  }
  if (f.kind === "html") {
    if (CHALLENGE_RE.test(text) && opts.isShell) {
      return {
        kind: "captcha_or_challenge",
        retryable: false,
        message: "The page is a bot-challenge interstitial.",
        nextAction: "Use a different source or the site's official API. " + BOOK,
      };
    }
    if (PAYWALL_RE.test(text) && opts.isShell) {
      return {
        kind: "paywall",
        retryable: false,
        message: "The page is behind a paywall.",
        nextAction: "Use a different source. " + BOOK,
      };
    }
    if (LOGIN_RE.test(text) && opts.isShell) {
      return {
        kind: "login_required",
        retryable: false,
        message: "The page is a login form.",
        nextAction: "Ask the user for an authenticated tool or a public mirror.",
      };
    }
    if (opts.isShell) {
      return {
        kind: "js_required",
        retryable: false,
        message: "The page is an empty client-rendered shell; its content only exists after JavaScript runs.",
        nextAction: "Look for the site's docs in markdown (llms.txt, API, GitHub), or ask the user to open the page.",
      };
    }
  }
  return null;
}
