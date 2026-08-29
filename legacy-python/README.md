# legacy-python (v1) — personal use only

This is the original Python implementation of websearch-mcp, kept for reference. **It is not the
respectful build.** On the spectrum in `../docs/SPECTRUM.md` it sits in the orange band:

- `curl_cffi` Chrome TLS impersonation (rung 9)
- `ddgs` undeclared scraping of search engines (rung 8–9)
- automatic fallback to `r.jina.ai` and the Wayback Machine after a block (rung 6-style intent)
- no robots.txt

It works well at home on a residential IP at low volume. Do not run it inside an organisation. The
maintained implementation is the TypeScript workspace at the repository root.

To run it anyway: `uv sync && uv run websearch-mcp` (Python ≥ 3.12 via `uv`).
