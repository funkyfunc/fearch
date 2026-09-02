# Releasing

Publishing runs in GitHub Actions via npm **trusted publishing** (OIDC): no npm token lives
anywhere, and every release carries a signed provenance attestation.

## One-time setup (already done once; repeat only if the trust is ever removed)

On npmjs.com → package `fearch-mcp` → Settings → **Trusted Publisher**:

- Publisher: GitHub Actions
- Organization or user: `funkyfunc`
- Repository: `fearch`
- Workflow filename: `release.yml`
- Environment: `release`

The `release` environment in the GitHub repo has no protection rules — it exists only so the npm
trust is scoped tighter than "any workflow in the repo".

## Cutting a release

1. Bump `version` in `packages/core/package.json` (and `server.json`, both `version` fields).
2. Commit, push, and confirm CI is green.
3. Tag and push the tag — the tag is the release button:

   ```bash
   git tag v2.0.1 && git push origin v2.0.1
   ```

The workflow re-runs lint/typecheck/tests on Linux and macOS, verifies the tag matches the package
version, then `npm publish --provenance` from `packages/core`.
