/**
 * Licence / preference signals a page carries: X-Robots-Tag, <meta name="robots">, noai/noimageai,
 * RSL and AIPREF headers, TDM Reservation Protocol. We do not act on most of these for a single
 * user-initiated read, but we surface them so downstream use can respect them and legal can audit.
 */

import * as cheerio from "cheerio";

/** Content Signals (contentsignals.org / Cloudflare): `search`, `ai-input`, `ai-train`, each yes/no. */
export interface ContentSignals {
  search?: boolean;
  aiInput?: boolean;
  aiTrain?: boolean;
  raw: string;
}

export function parseContentSignal(value: string | undefined | null): ContentSignals | null {
  if (!value) return null;
  const out: ContentSignals = { raw: value.trim() };
  for (const part of value.split(",")) {
    const m = /^\s*([a-z-]+)\s*=\s*(yes|no)\s*$/i.exec(part);
    if (!m) continue;
    const v = m[2].toLowerCase() === "yes";
    if (m[1].toLowerCase() === "search") out.search = v;
    if (m[1].toLowerCase() === "ai-input") out.aiInput = v;
    if (m[1].toLowerCase() === "ai-train") out.aiTrain = v;
  }
  return out;
}

/** Well-known licences by host, so attribution obligations travel with the content. */
export function knownLicence(host: string): string | null {
  const h = host.toLowerCase();
  if (/(^|\.)wikipedia\.org$/.test(h)) return "CC BY-SA 4.0 (Wikipedia) — attribute and link when reusing";
  if (/(^|\.)stackoverflow\.com$|(^|\.)stackexchange\.com$/.test(h))
    return "CC BY-SA 4.0 (Stack Exchange) — attribute authors and link when reusing";
  if (h === "developer.mozilla.org") return "CC BY-SA 2.5 prose, CC0 code samples (MDN)";
  return null;
}

export function licenceSignals(headers: Record<string, string>, html?: string): string[] {
  const out: string[] = [];
  const h = (k: string) => headers[k.toLowerCase()];
  const xrt = h("x-robots-tag");
  if (xrt) out.push(`X-Robots-Tag: ${xrt}`);
  const cs = parseContentSignal(h("content-signal"));
  if (cs) out.push(`Content-Signal: ${cs.raw}`);
  const tdm = h("tdm-reservation");
  if (tdm !== undefined) out.push(`tdm-reservation: ${tdm}` + (h("tdm-policy") ? ` (policy ${h("tdm-policy")})` : ""));
  for (const k of ["content-usage", "ai-preferences", "x-ai-preferences"]) {
    if (h(k)) out.push(`${k}: ${h(k)}`);
  }
  const link = h("link");
  if (link && /rel="?license"?/i.test(link)) out.push(`Link: ${link.slice(0, 200)}`);
  if (html) {
    try {
      const $ = cheerio.load(html.slice(0, 200_000));
      $('meta[name="robots"], meta[name="googlebot"], meta[name="ai"], meta[name="tdm-reservation"]').each((_, el) => {
        const name = $(el).attr("name");
        const content = $(el).attr("content");
        if (name && content) out.push(`meta ${name}: ${content}`);
      });
      const rsl = $('link[rel="license"][type*="rsl"], link[rel="license"][href*="rsl"]').attr("href");
      if (rsl) out.push(`RSL licence: ${rsl}`);
    } catch {
      // best effort
    }
  }
  return out;
}
