import { describe, expect, it } from "vitest";
import { assertPublicUrl, BlockedURL, isBlockedHostname, isPrivateAddress, normalizeUrl } from "../src/fetch/guard.js";

describe("guard", () => {
  it("normalizes", () => {
    expect(normalizeUrl("example.com/a#frag")).toBe("https://example.com/a");
    expect(normalizeUrl("http://example.com")).toBe("https://example.com/");
    expect(() => normalizeUrl("ftp://example.com/x")).toThrow(BlockedURL);
    expect(() => normalizeUrl("")).toThrow(BlockedURL);
    expect(() => normalizeUrl("https://user:pw@example.com/")).toThrow(BlockedURL);
  });

  it("classifies private addresses", () => {
    for (const ip of [
      "127.0.0.1",
      "10.0.0.5",
      "172.16.3.4",
      "192.168.1.1",
      "169.254.169.254",
      "100.64.1.1",
      "198.18.0.1",
      "0.0.0.0",
      "::1",
      "fe80::1",
      "fd00::1",
      "::ffff:10.0.0.1",
      // The WHATWG URL parser canonicalises `[::ffff:127.0.0.1]` to the hex form.
      "::ffff:7f00:1",
      "::ffff:a9fe:a9fe",
      "::7f00:1",
      "::127.0.0.1",
    ]) {
      expect(isPrivateAddress(ip), ip).toBe(true);
    }
    for (const ip of ["8.8.8.8", "1.1.1.1", "2606:4700::1111", "172.32.0.1", "::ffff:808:808", "::ffff:8.8.8.8"])
      expect(isPrivateAddress(ip), ip).toBe(false);
  });

  it("refuses IPv6-mapped loopback in every spelling the URL parser produces", async () => {
    for (const url of [
      "http://[::ffff:127.0.0.1]:8080/",
      "http://[::ffff:7f00:1]/",
      "http://[::ffff:169.254.169.254]/",
    ]) {
      expect(new URL(url).hostname).toMatch(/^\[::ffff:[0-9a-f]+:[0-9a-f]+\]$/); // canonicalised to hex
      await expect(assertPublicUrl(url), url).rejects.toThrow(BlockedURL);
    }
  });

  it("blocks internal hostnames", () => {
    for (const h of [
      "localhost",
      "metadata.google.internal",
      "printer.local",
      "foo.internal",
      "10-0-0-1.nip.io",
      "a.sslip.io",
    ]) {
      expect(isBlockedHostname(h), h).toBe(true);
    }
    expect(isBlockedHostname("example.com")).toBe(false);
  });

  it("refuses private targets by URL", async () => {
    for (const url of [
      "http://localhost:8080/admin",
      "http://127.0.0.1/",
      "http://10.0.0.5/secret",
      "http://169.254.169.254/latest/meta-data/",
      "http://[::1]/",
      "http://metadata.google.internal/",
    ]) {
      await expect(assertPublicUrl(url), url).rejects.toThrow(BlockedURL);
    }
  });

  it("allows private when configured", async () => {
    expect(await assertPublicUrl("http://127.0.0.1:9/", { allowPrivate: true })).toBe("https://127.0.0.1:9/");
  });
});
