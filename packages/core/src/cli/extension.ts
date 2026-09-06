/** `fearch extension install|status|path` — setting up the bridge extension in the person's Chrome. */

import { execFile } from "node:child_process";
import { cpSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import type { App } from "../app.js";
import { PACKAGE_DIR } from "../config.js";
import {
  EXTENSION_ID,
  ExtensionBridge,
  ExtensionRenderer,
  extensionInstalledMarker,
  loadOrCreateExtensionToken,
} from "../fetch/extension.js";
import type { Flags } from "./args.js";

/** Where the extension ships inside this package. */
export function bundledExtensionDir(): string {
  return join(PACKAGE_DIR, "extension");
}

/**
 * The folder Chrome should load. From a clone or a normal install that is the bundled folder itself —
 * nothing is copied. Only when the package lives in npm's ephemeral npx cache is it copied to a stable,
 * visible folder (file dialogs cannot show dot-directories).
 */
export function installedExtensionDir(): string {
  const bundled = bundledExtensionDir();
  return /[\\/](_npx|\.npm|npm-cache)[\\/]/.test(bundled) ? join(homedir(), "fearch-extension") : bundled;
}

export async function extensionCommand(app: App, sub: string, flags: Flags): Promise<number> {
  const out = (t: string) => process.stdout.write(t + "\n");
  const dir = installedExtensionDir();
  if (sub === "path") {
    out(dir);
    return 0;
  }
  const token = loadOrCreateExtensionToken(app.settings.cacheDir);
  const bridge = app.browser instanceof ExtensionRenderer ? app.browser.bridge : new ExtensionBridge(app.audit, token);
  try {
    if (sub === "install") return await install(bridge, dir, token, app.settings.cacheDir, out);
    return await status(bridge, dir, flags, out);
  } finally {
    await bridge.close();
  }
}

async function install(
  bridge: ExtensionBridge,
  dir: string,
  token: string,
  cacheDir: string,
  out: (t: string) => void,
): Promise<number> {
  if (dir !== bundledExtensionDir()) {
    mkdirSync(dir, { recursive: true });
    cpSync(bundledExtensionDir(), dir, { recursive: true });
  }
  // Pair this Chrome with this user's fearch: the extension refuses jobs from any server that cannot
  // prove it holds this token, and servers refuse polls without it.
  writeFileSync(join(dir, "token.json"), JSON.stringify({ token }) + "\n", { mode: 0o600 });
  // Tell auto mode an extension is worth waiting for on a fresh server's first render.
  writeFileSync(extensionInstalledMarker(cacheDir), new Date().toISOString() + "\n");
  const copied = await copyToClipboard(dir);
  const port = await bridge.start();
  out(`fearch bridge extension folder:\n  ${dir}${copied ? "   (path copied to your clipboard)" : ""}\n`);
  out("In Chrome (opening chrome://extensions for you):");
  out("  1. turn on “Developer mode” (top right)");
  out(
    "  2. click “Load unpacked”, press Cmd+Shift+G (macOS) or type in the path box, paste the folder above, and choose it",
  );
  out("  3. optional: in the extension's details, enable “Allow in Incognito” for --incognito");
  out("  (already loaded before? just click the ↻ reload button on its card so it picks up the new pairing token)");
  out(`\nExpected extension ID: ${EXTENSION_ID}.  Status page: http://127.0.0.1:${port}/setup`);
  openExtensionsPage();
  out("\nWaiting for the extension to connect (up to 3 minutes; Ctrl-C to stop)…");
  if (!(await bridge.waitForConnection(180_000))) {
    out("✘ not connected yet. Finish the steps above and run `fearch extension status`.");
    return 1;
  }
  const info = bridge.extensionInfo();
  out(
    `✔ connected — fearch bridge ${info?.version}; incognito ${info?.incognitoAllowed ? "allowed" : "not allowed (optional)"}.`,
  );
  out(
    "Auto mode uses it whenever it is connected (--browser extension pins it). Google: --engines google,duckduckgo; --human-search lets you press Enter yourself; --incognito keeps your profile out of it.",
  );
  return 0;
}

async function status(bridge: ExtensionBridge, dir: string, flags: Flags, out: (t: string) => void): Promise<number> {
  const port = await bridge.start();
  const waitMs = typeof flags.wait === "string" ? Number(flags.wait) * 1000 : 5_000;
  if (await bridge.waitForConnection(waitMs)) {
    const info = bridge.extensionInfo();
    out(
      `✔ fearch bridge ${info?.version} connected on port ${port}; incognito ${info?.incognitoAllowed ? "allowed" : "not allowed"}`,
    );
    return 0;
  }
  const folder = existsSync(dir) ? dir : "(not installed)";
  out(
    `✘ no extension connected on port ${port} within ${Math.round(waitMs / 1000)} s — installed? run \`fearch extension install\`. Folder: ${folder}`,
  );
  return 1;
}

/** True only when the clipboard tool actually ran and exited cleanly (a missing `xclip` reports false). */
function copyToClipboard(text: string): Promise<boolean> {
  const [cmd, args] =
    platform() === "darwin"
      ? ["pbcopy", []]
      : platform() === "win32"
        ? ["clip", []]
        : ["xclip", ["-selection", "clipboard"]];
  return new Promise((resolve) => {
    let p;
    try {
      p = execFile(cmd, args, (err) => resolve(!err));
    } catch {
      return resolve(false);
    }
    p.on("error", () => resolve(false));
    p.stdin?.end(text);
  });
}

function openExtensionsPage(): void {
  const url = "chrome://extensions/";
  const [cmd, args] =
    platform() === "darwin"
      ? ["open", ["-a", "Google Chrome", url]]
      : platform() === "win32"
        ? ["cmd", ["/c", "start", "chrome", url]]
        : ["google-chrome", [url]];
  try {
    execFile(cmd, args, () => {});
  } catch {
    // best effort
  }
}
