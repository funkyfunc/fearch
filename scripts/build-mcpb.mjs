/**
 * Build the one-click MCP Bundle (https://github.com/anthropics/mcpb): the whole server —
 * dist, production node_modules, the bridge extension — in a single .mcpb a person can
 * double-click into Claude Desktop. No Node install, no JSON editing, keys in the OS keychain.
 */
import { cpSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const core = join(root, "packages/core");
const pkg = JSON.parse(readFileSync(join(core, "package.json"), "utf8"));
const stage = join(root, "dist-mcpb/stage");
const run = (cmd, cwd) => execSync(cmd, { cwd, stdio: "inherit" });

rmSync(join(root, "dist-mcpb"), { recursive: true, force: true });
mkdirSync(stage, { recursive: true });

run("npm run build", core);
cpSync(join(core, "dist"), join(stage, "dist"), { recursive: true });
// The bridge extension rides along so `fearch extension install` works from the bundle. Never the
// pairing token: the whitelist here mirrors the npm files whitelist.
for (const f of ["background.js", "manifest.json", "status.html", "status.js"]) {
  mkdirSync(join(stage, "extension"), { recursive: true });
  cpSync(join(core, "extension", f), join(stage, "extension", f));
}
writeFileSync(
  join(stage, "package.json"),
  JSON.stringify({ name: pkg.name, version: pkg.version, type: "module", dependencies: pkg.dependencies }, null, 2),
);
run("npm install --omit=dev --no-fund --no-audit --ignore-scripts", stage);

writeFileSync(
  join(stage, "manifest.json"),
  JSON.stringify(
    {
      manifest_version: "0.3",
      name: "fearch",
      display_name: "fearch",
      version: pkg.version,
      description: pkg.description,
      author: { name: "funkyfunc" },
      homepage: "https://github.com/funkyfunc/fearch",
      server: {
        type: "node",
        entry_point: "dist/index.js",
        mcp_config: { command: "node", args: ["${__dirname}/dist/index.js"] },
      },
    },
    null,
    2,
  ),
);
run(`npx -y @anthropic-ai/mcpb pack "${stage}" "${join(root, "dist-mcpb", `fearch-${pkg.version}.mcpb`)}"`, root);
process.stdout.write(`\nBundle: dist-mcpb/fearch-${pkg.version}.mcpb\n`);
