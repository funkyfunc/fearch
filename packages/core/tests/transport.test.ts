import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Audit } from "../src/audit.js";
import { settingsFromEnv } from "../src/config.js";
import { describeNetworkError, FetchError, isTlsError, parseRetryAfter, Transport } from "../src/fetch/transport.js";

describe("transport", () => {
  let server: Server;
  let port = 0;
  let flakyHits = 0;
  let slowHits = 0;
  beforeAll(async () => {
    server = createServer((req, res) => {
      const host = req.headers.host ?? "";
      if (req.url === "/redir-same") return res.writeHead(302, { location: "/target" }).end();
      if (req.url === "/redir-cross") return res.writeHead(302, { location: `http://localhost:${port}/target` }).end();
      if (req.url === "/loop") return res.writeHead(302, { location: "/loop" }).end();
      if (req.url === "/big")
        return res.writeHead(200, { "content-type": "text/plain", "content-length": "99999999" }).end("x");
      if (req.url === "/flaky")
        return ++flakyHits === 1
          ? res.writeHead(429, { "retry-after": "0" }).end("slow down")
          : res.writeHead(200, { "content-type": "text/plain" }).end("recovered");
      if (req.url === "/slow") {
        slowHits++;
        return res.writeHead(429, { "retry-after": "3600" }).end("come back later");
      }
      if (req.url === "/target")
        return res
          .writeHead(200, { "content-type": "text/plain" })
          .end(`ok from ${host} ua=${req.headers["user-agent"]}`);
      res.writeHead(404).end();
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    port = (server.address() as { port: number }).port;
  });
  afterAll(() => server.close());

  const t = () => {
    const s = settingsFromEnv({ FEARCH_ALLOW_PRIVATE: "1", FEARCH_AUDIT_LOG: "off", FEARCH_LOG_LEVEL: "error" });
    return new Transport(s, new Audit(s));
  };

  it("sends the honest UA and follows same-host redirects", async () => {
    const r = await t().get(`http://127.0.0.1:${port}/redir-same`);
    expect(r.status).toBe(200);
    expect(r.finalUrl).toContain("/target");
    expect(new TextDecoder().decode(r.body as Uint8Array)).toMatch(/ua=fearch\//);
    expect(r.redirects.length).toBe(1);
  });

  it("consults the callback before a cross-host redirect and can refuse it", async () => {
    const seen: string[] = [];
    const r = await t().get(`http://127.0.0.1:${port}/redir-cross`, {
      beforeCrossHostRedirect: async (u) => void seen.push(u),
    });
    expect(seen).toEqual([`http://localhost:${port}/target`]);
    expect(r.finalUrl).toBe(`http://localhost:${port}/target`);
    await expect(
      t().get(`http://127.0.0.1:${port}/redir-cross`, {
        beforeCrossHostRedirect: async () => {
          throw new FetchError("robots says no");
        },
      }),
    ).rejects.toThrow("robots says no");
  });

  it("caps redirects and declared body size", async () => {
    await expect(t().get(`http://127.0.0.1:${port}/loop`)).rejects.toThrow(/Too many redirects/);
    await expect(t().get(`http://127.0.0.1:${port}/big`)).rejects.toThrow(/too large/);
  });

  it("obeys a short Retry-After exactly once; a long one stays a final answer", async () => {
    const r = await t().get(`http://127.0.0.1:${port}/flaky`);
    expect(r.status).toBe(200);
    expect(new TextDecoder().decode(r.body as Uint8Array)).toBe("recovered");
    expect(flakyHits).toBe(2);
    const long = await t().get(`http://127.0.0.1:${port}/slow`);
    expect(long.status).toBe(429);
    expect(slowHits).toBe(1);
  });

  it("parses Retry-After as delay-seconds or an HTTP-date", () => {
    expect(parseRetryAfter("7")).toBe(7);
    expect(parseRetryAfter(undefined)).toBeNull();
    expect(parseRetryAfter("garbage")).toBeNull();
    const inTen = parseRetryAfter(new Date(Date.now() + 10_000).toUTCString());
    expect(inTen).toBeGreaterThanOrEqual(9);
    expect(inTen).toBeLessThanOrEqual(11);
    expect(parseRetryAfter(new Date(Date.now() - 5_000).toUTCString())).toBe(0);
  });
});

describe("network error descriptions", () => {
  it("names the NODE_EXTRA_CA_CERTS fix for TLS-interception failures and classifies the rest", () => {
    const tls = Object.assign(new Error("fetch failed"), {
      cause: { code: "UNABLE_TO_VERIFY_LEAF_SIGNATURE", message: "unable to verify the first certificate" },
    });
    expect(isTlsError(tls)).toBe(true);
    expect(describeNetworkError(tls)).toMatch(/TLS certificate not trusted.*NODE_EXTRA_CA_CERTS/);
    expect(describeNetworkError(Object.assign(new Error("fetch failed"), { cause: { code: "ENOTFOUND" } }))).toBe(
      "DNS lookup failed",
    );
    expect(describeNetworkError(Object.assign(new Error("fetch failed"), { cause: { code: "ECONNREFUSED" } }))).toBe(
      "connection refused",
    );
    expect(isTlsError(new Error("fetch failed"))).toBe(false);
  });
});
