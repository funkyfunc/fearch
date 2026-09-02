/**
 * SSRF guard: refuse private / loopback / link-local / metadata / DNS-rebinding targets.
 * DNS is resolved before connecting and every redirect hop is re-validated by the transport.
 */

import { lookup as lookupCb } from "node:dns";
import { lookup } from "node:dns/promises";
import { isIP, type LookupFunction } from "node:net";

export class BlockedURL extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BlockedURL";
  }
}

const BLOCKED_HOSTNAMES = new Set(["localhost", "metadata.google.internal", "metadata", "instance-data"]);
const BLOCKED_SUFFIXES = [
  ".local",
  ".localhost",
  ".internal",
  ".nip.io",
  ".sslip.io",
  ".1u.ms",
  ".xip.io",
  ".localtest.me",
];

function v4ToInt(ip: string): number {
  return ip.split(".").reduce((acc, o) => ((acc << 8) + Number(o)) >>> 0, 0);
}

const V4_PRIVATE: Array<[string, number]> = [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
  ["255.255.255.255", 32],
];

function inV4(ip: string, base: string, bits: number): boolean {
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  return (v4ToInt(ip) & mask) >>> 0 === (v4ToInt(base) & mask) >>> 0;
}

export function isPrivateAddress(ip: string): boolean {
  const kind = isIP(ip);
  if (kind === 4) return V4_PRIVATE.some(([base, bits]) => inV4(ip, base, bits));
  if (kind === 6) {
    const lower = ip.toLowerCase().replace(/^\[|\]$/g, "");
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
    if (mapped) return isPrivateAddress(mapped[1]);
    if (lower === "::1" || lower === "::") return true;
    if (/^f[cd]/.test(lower)) return true; // fc00::/7 unique local
    if (/^fe[89ab]/.test(lower)) return true; // fe80::/10 link-local
    if (/^ff/.test(lower)) return true; // multicast
    if (lower.startsWith("2001:db8")) return true; // documentation
    if (lower.startsWith("64:ff9b")) return true; // NAT64 — could map to v4 private
    return false;
  }
  return true; // not an IP literal — caller resolved it wrong
}

export function isBlockedHostname(host: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, "");
  if (BLOCKED_HOSTNAMES.has(h)) return true;
  if (BLOCKED_SUFFIXES.some((s) => h.endsWith(s))) return true;
  // hostnames that embed an IP (e.g. 10-0-0-1.example) are handled by DNS resolution
  return false;
}

/** Add a scheme if missing, upgrade http→https (unless keepScheme), drop fragments and credentials. */
export function normalizeUrl(raw: string, opts: { keepScheme?: boolean } = {}): string {
  const s = raw.trim();
  if (!s) throw new BlockedURL("Empty URL.");
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : "https://" + s;
  let u: URL;
  try {
    u = new URL(withScheme);
  } catch {
    throw new BlockedURL(`Invalid URL: ${raw}`);
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new BlockedURL(`Unsupported URL scheme '${u.protocol.replace(":", "")}'. Only http(s) is allowed.`);
  }
  if (u.username || u.password) throw new BlockedURL("URLs with embedded credentials are not allowed.");
  if (!u.hostname) throw new BlockedURL(`URL has no host: ${raw}`);
  if (u.protocol === "http:" && !opts.keepScheme) u.protocol = "https:";
  u.hash = "";
  if (s.length > 4000) throw new BlockedURL("URL too long.");
  return u.toString();
}

export interface GuardOptions {
  allowPrivate?: boolean;
  /** Keep http:// as given (used for redirect targets, where the server chose the scheme). */
  keepScheme?: boolean;
}

export type LookupFn = LookupFunction;

/**
 * A `lookup` for the socket layer that refuses private results at connection time. The pre-check in
 * `assertPublicUrl` resolves once; a rebinding host can answer differently a moment later, so the
 * address the socket actually uses is validated here too.
 */
export function guardedLookup(base: LookupFn = lookupCb as unknown as LookupFn): LookupFn {
  return (hostname, options, callback) => {
    base(hostname, options, (err, address, family) => {
      if (err) return callback(err, address, family);
      const list = Array.isArray(address) ? (address as Array<{ address: string }>) : [{ address: String(address) }];
      const bad = list.find((a) => isPrivateAddress(a.address));
      if (bad) {
        const e = new Error(
          `Refusing to connect to '${hostname}': resolves to private/internal address ${bad.address}`,
        ) as NodeJS.ErrnoException;
        e.code = "EPRIVATEADDR";
        return callback(e, address, family);
      }
      callback(null, address, family);
    });
  };
}

/** Validate and normalize a URL, resolving the host and rejecting private ranges. */
export async function assertPublicUrl(raw: string, opts: GuardOptions = {}): Promise<string> {
  const url = normalizeUrl(raw, { keepScheme: opts.keepScheme });
  if (opts.allowPrivate) return url;
  const host = new URL(url).hostname.replace(/^\[|\]$/g, "");
  if (isBlockedHostname(host)) {
    throw new BlockedURL(`Refusing to fetch private host '${host}' (set FEARCH_ALLOW_PRIVATE=1 to allow).`);
  }
  if (isIP(host)) {
    if (isPrivateAddress(host))
      throw new BlockedURL(`Refusing to fetch private address ${host} (set FEARCH_ALLOW_PRIVATE=1 to allow).`);
    return url;
  }
  let addrs: Array<{ address: string }>;
  try {
    addrs = await lookup(host, { all: true, verbatim: true });
  } catch (e) {
    throw new BlockedURL(`DNS resolution failed for '${host}': ${(e as Error).message}`);
  }
  if (!addrs.length) throw new BlockedURL(`DNS resolution returned no addresses for '${host}'.`);
  for (const a of addrs) {
    if (isPrivateAddress(a.address)) {
      throw new BlockedURL(
        `Refusing to fetch '${host}': resolves to private/internal address ${a.address} (set FEARCH_ALLOW_PRIVATE=1 to allow).`,
      );
    }
  }
  return url;
}
