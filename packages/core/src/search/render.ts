/** Render search results as compact markdown (cheaper for the model than JSON), with disclosure. */

import type { SearchOutcome } from "./registry.js";

export function renderResults(query: string, o: SearchOutcome): string {
  const via = o.fromCache ? "cache" : o.providers.map((p) => p.name).join(" + ") || "none";
  const disclosures = o.fromCache ? [] : [...new Set(o.providers.map((p) => p.disclosure))];
  const lines = [`Results for "${query}" (${o.results.length}, via ${via}):`];
  if (o.summary) {
    const label =
      o.summary.provider === "google" ? "Google's AI Overview" : `${o.summary.provider}'s generated summary`;
    lines.push(
      "",
      `> **${label}** (the engine's model wrote this — unverified; check the sources):`,
      `> ${o.summary.text}`,
    );
    const sources = o.summary.sources.filter((s) => s.url);
    if (sources.length) lines.push(`> Sources: ${sources.map((s, i) => `[${i + 1}] ${s.url}`).join(" · ")}`);
  }
  if (disclosures.length) lines.push(`Provider: ${disclosures.join("; ")}`);
  const engines = o.providers.filter((p) => p.posture === "browser").map((p) => p.name);
  if (engines.length) {
    lines.push(
      `Note: result pages of ${engines.join(", ")} were opened in the browser tier (one page per search, no stealth); see the Provider line for robots and logging facts.`,
    );
  }
  if (o.fellBackToFederation) {
    lines.push(
      "Note: no general-web provider answered; these come from keyless first-party APIs (Stack Overflow, MDN, Hacker News, Wikipedia, GitHub). Try a more specific `kind`, or ask the user for a URL.",
    );
  }
  for (const n of [...new Set(o.notes ?? [])]) lines.push(`Note: ${n}`);
  lines.push("");
  o.results.forEach((r, i) => {
    lines.push(`${i + 1}. **${r.title || r.url}** — ${r.url}${r.date ? ` · ${r.date}` : ""}`);
    if (r.snippet) lines.push(`   ${r.snippet}`);
    if (r.excerpt)
      lines.push(
        r.excerpt
          .split("\n")
          .map((l) => (l.trim() ? `   > ${l}` : "   >"))
          .join("\n"),
      );
    lines.push("");
  });
  lines.push("Use `fetch(url=...)` to read a result; `mode=focus, query=...` returns only the relevant sections.");
  return lines.join("\n").replace(/\s+$/, "") + "\n";
}
