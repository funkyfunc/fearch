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
