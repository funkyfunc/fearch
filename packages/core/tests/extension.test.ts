/**
 * The extension tier. Unit tests drive the bridge with a fake extension client; the integration test
 * loads the real unpacked extension into Playwright's Chromium (skipped if Chromium is unavailable).
 */
import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Audit } from "../src/audit.js";
import { settingsFromEnv } from "../src/config.js";
import { EXTENSION_ID, ExtensionBridge, ExtensionRenderer } from "../src/fetch/extension.js";
import { BrowserUnavailable, type BrowserTier } from "../src/fetch/browser.js";

const settings = (env: Record<string, string> = {}) =>
  settingsFromEnv({
    FEARCH_NO_CACHE: "1",
    FEARCH_AUDIT_LOG: "off",
    FEARCH_LOG_LEVEL: "error",
    FEARCH_ALLOW_PRIVATE: "1",
    FEARCH_BROWSER: "extension",
    FEARCH_EXTENSION_CONNECT_MS: "300",
    ...env,
  });
const audit = () => new Audit({ auditLog: "off", logLevel: "error" });
const ORIGIN = { origin: `chrome-extension://${EXTENSION_ID}`, "content-type": "application/json" };
// Use a port range that cannot collide with a running fearch server.
const TEST_PORTS = [47470, 47471, 47472];
const TOKEN = "test-pairing-token";
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

describe("extension bridge (fake extension client)", () => {
  it("pairs via the shared token, hands out proven jobs, and returns authenticated results", async () => {
    const bridge = new ExtensionBridge(audit(), TOKEN, EXTENSION_ID, TEST_PORTS);
    const port = await bridge.start();
    expect(TEST_PORTS).toContain(port);
    expect(bridge.connected()).toBe(false);
    // a web page / random client is refused by origin
    expect((await fetch(`http://127.0.0.1:${port}/fearch/next`, { method: "POST", body: "{}" })).status).toBe(403);
    expect(
      (
        await fetch(`http://127.0.0.1:${port}/fearch/next`, {
          method: "POST",
          body: "{}",
          headers: { origin: "https://evil.example" },
        })
      ).status,
    ).toBe(403);
    // the right origin but no (or a wrong) pairing proof is refused too — a local impostor can spoof
    // the Origin header, so the token is what actually gates the bridge
    const unpaired = await fetch(`http://127.0.0.1:${port}/fearch/next`, {
      method: "POST",
      headers: ORIGIN,
      body: JSON.stringify({ version: "9.9.9", nonce: "n1", auth: sha("wrong-token:poll:n1") }),
    });
    expect(unpaired.status).toBe(403);
    expect(((await unpaired.json()) as { error: string }).error).toContain("not paired");
    expect(bridge.connected()).toBe(false);
    // a paired poll gets the job, with the server's proof over the poll nonce and job id
    const pending = bridge.request({ op: "ping" });
    const nonce = "n2";
    const poll = await fetch(`http://127.0.0.1:${port}/fearch/next`, {
      method: "POST",
      headers: ORIGIN,
      body: JSON.stringify({ version: "9.9.9", incognitoAllowed: true, nonce, auth: sha(`${TOKEN}:poll:${nonce}`) }),
    });
    expect(poll.status).toBe(200);
    const job = (await poll.json()) as { id: string; op: string; proof: string };
    expect(job.op).toBe("ping");
    expect(job.proof).toBe(sha(`${TOKEN}:job:${nonce}:${job.id}`));
    expect(bridge.connected()).toBe(true);
    expect(bridge.extensionInfo()).toEqual({ version: "9.9.9", incognitoAllowed: true });
    // a result without the pairing auth is dropped; with it, the pending request resolves
    await fetch(`http://127.0.0.1:${port}/fearch/result`, {
      method: "POST",
      headers: ORIGIN,
      body: JSON.stringify({ id: job.id, ok: true, version: "9.9.9" }),
    });
    await fetch(`http://127.0.0.1:${port}/fearch/result`, {
      method: "POST",
      headers: ORIGIN,
      body: JSON.stringify({ id: job.id, ok: true, version: "9.9.9", auth: sha(`${TOKEN}:result:${job.id}`) }),
    });
    expect((await pending).ok).toBe(true);
    // status and setup pages are readable without an origin (a person's browser tab)
    expect(
      ((await (await fetch(`http://127.0.0.1:${port}/fearch/status`)).json()) as { connected: boolean }).connected,
    ).toBe(true);
    expect(await (await fetch(`http://127.0.0.1:${port}/setup`)).text()).toContain(EXTENSION_ID);
    await bridge.close();
  });

  it("falls back to another tier when no extension is connected, and says why when there is none", async () => {
    const bridge = new ExtensionBridge(audit(), TOKEN, EXTENSION_ID, TEST_PORTS);
    const calls: string[] = [];
    const fallback = {
      enabled: () => true,
      headed: false,
      browserUserAgent: "x",
      browserChannel: "chromium",
      async render(u: string) {
        calls.push(u);
        return {
          html: "<main>fallback</main>",
          finalUrl: u,
          status: 200,
          salvaged: false,
          usedSession: false,
          handedOff: false,
        };
      },
      async close() {},
    } as BrowserTier;
    const r = new ExtensionRenderer(settings(), audit(), bridge, fallback);
    const out = await r.render("http://127.0.0.1:1/x");
    expect(out.html).toContain("fallback");
    expect(calls.length).toBe(1);
    const strict = new ExtensionRenderer(
      settings(),
      audit(),
      new ExtensionBridge(audit(), TOKEN, EXTENSION_ID, [47473]),
    );
    await expect(strict.render("http://127.0.0.1:1/x")).rejects.toThrow(BrowserUnavailable);
    await r.close();
    await strict.close();
  });
});

describe("extension tier (real extension in Playwright Chromium)", () => {
  let site: Server;
  let base = "";
  let ctx: import("playwright").BrowserContext | null = null;
  let bridge: ExtensionBridge;
  let available = true;
  beforeAll(async () => {
    site = createServer((req, res) => {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(
        `<html><head><title>Ext test</title></head><body><main><h1>Hello</h1><p>${"Rendered in the user's browser. ".repeat(10)}</p><script>document.querySelector('h1').textContent += ' (JS ran)'</script></main></body></html>`,
      );
    });
    await new Promise<void>((r) => site.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(site.address() as { port: number }).port}`;
    // The real extension scans the production port range; the bridge must be on it for this test.
    bridge = new ExtensionBridge(audit(), TOKEN);
    try {
      await bridge.start();
      const { chromium } = await import("playwright");
      // Pair a temp copy of the extension the way `fearch extension install` does: token.json inside.
      const { cpSync, mkdtempSync, writeFileSync } = await import("node:fs");
      const { tmpdir } = await import("node:os");
      const { join } = await import("node:path");
      const { fileURLToPath } = await import("node:url");
      const ext = join(mkdtempSync(join(tmpdir(), "fearch-ext-")), "extension");
      cpSync(fileURLToPath(new URL("../extension/", import.meta.url)), ext, { recursive: true });
      writeFileSync(join(ext, "token.json"), JSON.stringify({ token: TOKEN }));
      ctx = await chromium.launchPersistentContext("", {
        headless: true,
        channel: "chromium",
        args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`],
      });
      available = await bridge.waitForConnection(20_000);
      if (!available && process.env.CI) throw new Error("the real extension did not connect within 20 s in CI");
    } catch (e) {
      available = false;
      // CI installs Chromium: unavailability there is broken setup, and silence would shed this coverage.
      if (process.env.CI) throw e;
    }
  }, 60_000);
  afterAll(async () => {
    await ctx?.close().catch(() => {});
    await bridge?.close();
    site.close();
  });

  it("loads with the fixed ID, connects, renders a page with JavaScript, and closes its tab", async (ctx) => {
    if (!available) return ctx.skip(); // no Chromium here
    expect(ctx!.serviceWorkers()[0]?.url()).toContain(`chrome-extension://${EXTENSION_ID}/`);
    const r = new ExtensionRenderer(settings(), audit(), bridge);
    const out = await r.render(`${base}/page`);
    expect(out.html).toContain("Hello (JS ran)");
    expect(out.finalUrl).toBe(`${base}/page`);
    expect(out.label).toBe("your Chrome");
    // only the profile's initial tab and the bridge's blank window tab remain
    expect(ctx!.pages().every((p) => !p.url().startsWith(base))).toBe(true);
    // private addresses are refused before a tab is opened
    await expect(
      new ExtensionRenderer(settings({ FEARCH_ALLOW_PRIVATE: "" }), audit(), bridge).render(
        "http://169.254.169.254/latest/",
      ),
    ).rejects.toThrow();
  }, 60_000);
});
