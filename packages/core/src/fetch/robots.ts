/**
 * robots.txt (RFC 9309) enforcement, on by default and fail-closed.
 *
 * We honor rules for our own token, `*`, and — voluntarily — the AI-agent tokens, so a site that has
 * opted out of AI agents is treated as having opted out of us. Documented public API hosts are
 * exempt: robots.txt governs crawling; API terms govern those requests.
 */

import robotsParserImport from "robots-parser";
import type { Cache } from "../cache.js";

interface Robot {
  isDisallowed(url: string, ua?: string): boolean | undefined;
  getCrawlDelay(ua?: string): number | undefined;
}
const robotsParser = robotsParserImport as unknown as (url: string, contents: string) => Robot;
import { PRODUCT } from "../config.js";
import { isApiUrl } from "./resolver.js";
import { describeNetworkError, FetchError } from "./transport.js";

/**
 * Which robots.txt user-agent groups we honour besides `*` and our own token.
 * - `default`: the user-initiated agent tokens. A site that blocks "a person asked an assistant to
 *   open this page" has answered our exact question. Training-crawler opt-outs are *not* applied —
 *   we don't train, and treating "don't use me as a dataset" as "don't read me" misreads the signal.
 * - `strict`: also honour training/indexing crawler opt-outs (the most conservative reading).
 */
export type RobotsPolicy = "default" | "strict";
export const USER_AGENT_TOKENS = ["Claude-User", "ChatGPT-User"];
export const TRAINING_TOKENS = ["GPTBot", "ClaudeBot", "anthropic-ai", "Claude-Web", "Google-Extended", "CCBot"];

export function tokensFor(policy: RobotsPolicy): string[] {
  if (policy === "strict") return [PRODUCT, ...USER_AGENT_TOKENS, ...TRAINING_TOKENS];
  return [PRODUCT, ...USER_AGENT_TOKENS];
}

export interface RobotsDecision {
  allowed: boolean;
  status: "allowed" | "disallowed" | "api" | "unavailable";
  reason?: string;
  crawlDelayMs?: number;
  /** Set when a `Content-Signal:` line in robots.txt says `ai-input=no`. */
  contentSignal?: string;
}

/**
 * A robots.txt `Content-Signal:` line saying `ai-input=no` that applies to us, read the way
 * contentsignals.org scopes it: inside a `User-agent` group naming `*` or one of our tokens, and
 * optionally limited to a path prefix (`Content-Signal: /blog/ ai-input=no`). A signal aimed at
 * another crawler, or at another part of the site, is not a signal to this tool.
 */
export function robotsContentSignalNoAiInput(body: string, url: string, tokens: string[]): string | null {
  const ours = new Set(["*", ...tokens.map((t) => t.toLowerCase())]);
  const path = new URL(url).pathname;
  let agents: string[] = [];
  let groupOpen = false; // a directive has followed the User-agent lines
  for (const raw of body.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, "").trim();
    const m = /^([a-z-]+)\s*:\s*(.*)$/i.exec(line);
    if (!m) continue;
    const key = m[1].toLowerCase();
    const value = m[2].trim();
    if (key === "user-agent") {
      if (groupOpen) {
        agents = [];
        groupOpen = false;
      }
      agents.push(value.toLowerCase());
      continue;
    }
    groupOpen = true;
    if (key !== "content-signal" || !agents.some((a) => ours.has(a))) continue;
    const scoped = /^(\/\S*)\s+(.*)$/.exec(value);
    const prefix = scoped ? scoped[1] : "/";
    const signals = scoped ? scoped[2] : value;
    if (path.startsWith(prefix) && /ai-input\s*=\s*no/i.test(signals)) return value;
  }
  return null;
}

export interface RobotsFetcher {
  (url: string, opts: { httpFallback: boolean }): Promise<{ status: number; body: string }>;
}

export interface RobotsCheckOptions {
  /** The page URL was upgraded to https optimistically; the robots probe may fall back to http too. */
  httpFallback?: boolean;
}

export class RobotsChecker {
  constructor(
    private readonly cache: Cache,
    private readonly fetchRobots: RobotsFetcher,
    private readonly policy: RobotsPolicy = "default",
  ) {}

  async check(url: string, opts: RobotsCheckOptions = {}): Promise<RobotsDecision> {
    const u = new URL(url);
    const host = u.host.toLowerCase();
    if (isApiUrl(url)) return { allowed: true, status: "api" };

    let entry = this.cache.getRobots(host);
    if (!entry) {
      let status = 0;
      let body = "";
      try {
        const r = await this.fetchRobots(`${u.protocol}//${u.host}/robots.txt`, { httpFallback: !!opts.httpFallback });
        status = r.status;
        body = r.body;
      } catch (e) {
        // status 0 = could not fetch; keep the reason in `body` so the diagnosis can say why
        // (a TLS-interception failure looks like "disallowed" otherwise and sends people the wrong way).
        status = 0;
        body =
          e instanceof FetchError ? e.message.replace(/^Connection failed for \S+: /, "") : describeNetworkError(e);
      }
      // A network failure is not the host's answer: remember only what the host actually said.
      if (status !== 0) this.cache.setRobots(host, status, body);
      entry = { host, status, body, fetchedAt: Date.now() };
    }

    if (entry.status === 404 || entry.status === 410)
      return { allowed: true, status: "allowed", reason: "no robots.txt" };
    if (entry.status === 401 || entry.status === 403) {
      // RFC 9309 §2.3.1.3 lets a crawler treat a 4xx as "no robots.txt". fearch chooses the
      // conservative reading: a host that refuses to say its rules is not asked for anything else.
      // Reported as `unavailable`, not `disallowed`: a WAF answering our User-Agent is not the
      // operator's stated decision, and the diagnosis must not read as one.
      return {
        allowed: false,
        status: "unavailable",
        reason: `robots.txt returned HTTP ${entry.status}; fearch fails closed on 4xx (RFC 9309 §2.3.1.3 would permit access)`,
      };
    }
    if (entry.status === 0 || entry.status >= 500) {
      const why = entry.status ? `HTTP ${entry.status}` : entry.body || "network error";
      return {
        allowed: false,
        status: "unavailable",
        reason: `robots.txt unreachable (${why}); disallowed per RFC 9309 §2.3.1.4`,
      };
    }
    if (entry.status !== 200) return { allowed: true, status: "allowed", reason: `robots.txt HTTP ${entry.status}` };

    // robots-parser never throws: unparseable lines are skipped (RFC 9309 §2.3.1.5).
    const robots: Robot = robotsParser(`${u.protocol}//${u.host}/robots.txt`, entry.body);

    for (const token of tokensFor(this.policy)) {
      if (robots.isDisallowed(url, token)) {
        const why =
          token === PRODUCT
            ? "disallowed for this agent"
            : TRAINING_TOKENS.includes(token)
              ? `site opts out of AI crawlers (${token}; strict policy)`
              : `site has opted out of user-initiated AI agents (${token})`;
        return { allowed: false, status: "disallowed", reason: why };
      }
    }
    const delay = robots.getCrawlDelay(PRODUCT) ?? robots.getCrawlDelay("*");
    // Content Signals in robots.txt: `ai-input=no` says "don't feed my pages into an AI model" —
    // exactly what a coding assistant does with a fetched page.
    const cs = robotsContentSignalNoAiInput(entry.body, url, tokensFor(this.policy));
    if (cs)
      return {
        allowed: false,
        status: "disallowed",
        reason: `Content-Signal ai-input=no in robots.txt (${cs})`,
        contentSignal: cs,
      };
    return { allowed: true, status: "allowed", crawlDelayMs: delay ? Math.min(delay, 30) * 1000 : undefined };
  }
}
