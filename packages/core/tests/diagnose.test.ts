import { describe, expect, it } from "vitest";
import { diagnose, renderDiagnosis } from "../src/fetch/diagnose.js";
import type { Fetched } from "../src/fetch/types.js";

const f = (
  status: number,
  body = "",
  headers: Record<string, string> = {},
  kind: Fetched["kind"] = "html",
): Fetched => ({
  url: "https://x.test/",
  finalUrl: "https://x.test/",
  kind,
  body,
  source: "direct",
  status,
  contentType: "text/html",
  headers,
});

describe("diagnose", () => {
  it("classifies statuses", () => {
    expect(diagnose(f(404))?.kind).toBe("not_found");
    expect(diagnose(f(402))?.kind).toBe("payment_required");
    expect(diagnose(f(451))?.kind).toBe("unavailable_for_legal_reasons");
    expect(diagnose(f(500))?.kind).toBe("server_error");
    expect(diagnose(f(403, "<html>Forbidden</html>"))?.kind).toBe("blocked_or_waf");
    expect(diagnose(f(401))?.kind).toBe("login_required");
  });

  it("recognises challenges and rate limits with retry-after", () => {
    const cf = diagnose(f(503, "<title>Just a moment...</title><script src='/cdn-cgi/challenge-platform/x'></script>"));
    expect(cf?.kind).toBe("captcha_or_challenge");
    expect(cf?.retryable).toBe(false);
    const rl = diagnose(f(429, "", { "retry-after": "120" }));
    expect(rl?.kind).toBe("rate_limited");
    expect(rl?.retryAfterSeconds).toBe(120);
  });

  it("classifies 200 shells", () => {
    expect(diagnose(f(200, "<div id=root></div>"), { isShell: true })?.kind).toBe("js_required");
    expect(diagnose(f(200, "<form><input type='password'></form>"), { isShell: true })?.kind).toBe("login_required");
    expect(diagnose(f(200, '{"isAccessibleForFree": false}'), { isShell: true })?.kind).toBe("paywall");
    expect(diagnose(f(200, "<main>lots of real content</main>"), { isShell: false })).toBeNull();
  });

  it("renders a block the model can act on", () => {
    const d = diagnose(f(403, "<html>Forbidden</html>"))!;
    const text = renderDiagnosis(d);
    expect(text).toContain("kind: blocked_or_waf");
    expect(text).toContain("retryable: false");
    expect(text).toContain("never does that");
  });
});

describe("isChallengePage — Turnstile lives in an invisible iframe", () => {
  it("treats a Turnstile on an otherwise empty page as a challenge, but not one embedded in real content", async () => {
    const { isChallengePage } = await import("../src/fetch/diagnose.js");
    const demo = `<html><head><title>x</title><script src="https://challenges.cloudflare.com/turnstile/v0/api.js"></script></head><body><div class="cf-turnstile"></div><h1>BY NODRIVER</h1></body></html>`;
    expect(isChallengePage(demo)).toBe(true);
    const login = `<html><body><main><h1>Sign up</h1><p>${"Real page content around an embedded widget. ".repeat(30)}</p><div class="cf-turnstile"></div></main></body></html>`;
    expect(isChallengePage(login)).toBe(false);
    // the classic interstitial still matches on its own markers
    expect(isChallengePage(`<html><head><title>Just a moment...</title></head><body></body></html>`)).toBe(true);
    expect(isChallengePage(`<html><body><main>ordinary page</main></body></html>`)).toBe(false);
  });

  it("does not mistake a protected page that loaded fine, or an article about bot management, for a challenge", async () => {
    const { isChallengePage } = await import("../src/fetch/diagnose.js");
    // Cloudflare leaves its bot-detection script on every page of a protected site (help.openai.com, 2026-09-02).
    const article = `<html><head><title>ChatGPT Work's Cloud browser allowlisting | OpenAI Help Center</title></head><body><main><h1>Allowlisting</h1><p>${"Cloudflare recognizes Cloud browser traffic as a signed agent. HUMAN (formerly PerimeterX) and DataDome verify request signatures automatically. ".repeat(12)}</p></main><script src="/cdn-cgi/challenge-platform/scripts/jsd/main.js"></script><script>window._cf_chl_opt={}</script></body></html>`;
    expect(isChallengePage(article, 200, "https://help.openai.com/en/articles/1")).toBe(false);
    // …while the interstitial that precedes it (little text, the same markers) is one
    const interstitial = `<html><head><title>Just a moment...</title></head><body><div id="challenge-body-text">Checking your browser before accessing help.openai.com.</div><script src="/cdn-cgi/challenge-platform/h/b/orchestrate/chl_page/v1"></script></body></html>`;
    expect(isChallengePage(interstitial, 200)).toBe(true);
    // a post-verification interstitial with no title marker but almost no text is still a challenge
    expect(
      isChallengePage(
        `<html><head><title>Just a moment...</title></head><body><p>Verification successful. Waiting for www.example.test to respond</p></body></html>`,
      ),
    ).toBe(true);
    expect(isChallengePage(`<html><body><p>We must verify your session before you can proceed</p></body></html>`)).toBe(
      true,
    );
    // a status that says so needs no markup
    expect(isChallengePage("<html><body>slow down</body></html>", 429)).toBe(true);
  });
});
