// fearch bridge — the whole extension. It long-polls fearch servers on this machine for jobs and knows
// three verbs: open a URL in a background tab, read the tab's HTML, close the tab (plus "activate", to
// bring a tab forward when a site shows a challenge, or a search box, for you to deal with). Nothing is
// clicked, typed or submitted; no chrome.debugger; no automation flags. It only ever touches tabs it opened.
//
// Pairing: `fearch extension install` writes token.json next to this file. Every poll proves we hold
// the token (SHA-256 over a fresh nonce), and every job must carry the server's matching proof back —
// so a rogue local process that binds the port first cannot drive this extension, and the token never
// crosses the wire.
const PORTS = [47365, 47366, 47367, 47368, 47369];
const VERSION = chrome.runtime.getManifest().version;
const loops = new Map(); // port -> true while a loop runs
const state = { servers: {}, lastError: "" };
const windows = { normal: null, incognito: null };
const ownedTabs = new Set();
/** The about:blank tab a window is created with; removed once a real tab exists. */
const starterTabs = new Map(); // windowId -> tabId

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let TOKEN = null;
const tokenReady = fetch(chrome.runtime.getURL("token.json"))
  .then((r) => r.json())
  .then((j) => {
    TOKEN = typeof j.token === "string" && j.token ? j.token : null;
  })
  .catch(() => {
    state.lastError = "token.json missing — run `fearch extension install` to pair, then reload the extension";
  });

async function sha256hex(s) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, "0")).join("");
}

function newNonce() {
  const b = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

async function hello() {
  let incognitoAllowed = false;
  try {
    incognitoAllowed = await chrome.extension.isAllowedIncognitoAccess();
  } catch {}
  return { version: VERSION, incognitoAllowed };
}

async function ensureWindow(incognito) {
  const key = incognito ? "incognito" : "normal";
  const id = windows[key];
  if (id !== null) {
    try {
      await chrome.windows.get(id);
      return id;
    } catch {
      windows[key] = null;
    }
  }
  const win = await chrome.windows.create({ url: "about:blank", focused: false, incognito, state: "minimized" });
  windows[key] = win.id;
  const starter = win.tabs && win.tabs[0];
  if (starter) starterTabs.set(win.id, starter.id);
  return win.id;
}

/** Chrome needs a window to have a tab; the blank starter goes as soon as a fearch tab exists. */
async function dropStarterTab(windowId) {
  const id = starterTabs.get(windowId);
  if (id === undefined) return;
  starterTabs.delete(windowId);
  await chrome.tabs.remove(id).catch(() => {});
}

/** After the last fearch tab in a window closes, close the window too, rather than leave an empty one around. */
async function closeWindowIfEmpty(windowId) {
  try {
    const tabs = await chrome.tabs.query({ windowId });
    if (tabs.some((t) => ownedTabs.has(t.id))) return;
    for (const key of Object.keys(windows)) if (windows[key] === windowId) windows[key] = null;
    await chrome.windows.remove(windowId);
  } catch {}
}

function waitLoaded(tabId, timeoutMs) {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      chrome.tabs.onUpdated.removeListener(onUpdated);
      resolve();
    };
    const onUpdated = (id, info) => {
      if (id === tabId && info.status === "complete") finish();
    };
    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs
      .get(tabId)
      .then((t) => t.status === "complete" && finish())
      .catch(finish);
    setTimeout(finish, timeoutMs);
  });
}

async function snapshot(tabId) {
  const [r] = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => ({ html: document.documentElement.outerHTML, url: location.href, title: document.title }),
  });
  return r.result;
}

async function settle(tabId, selector, ms) {
  if (!selector) return;
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try {
      const [r] = await chrome.scripting.executeScript({
        target: { tabId },
        func: (s) => !!document.querySelector(s),
        args: [selector],
      });
      if (r.result) return;
    } catch {}
    await sleep(250);
  }
}

async function handle(job) {
  switch (job.op) {
    case "ping":
      return { ok: true, ...(await hello()) };
    case "open": {
      const u = new URL(job.url);
      if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("only http(s) URLs");
      if (job.incognito && !(await hello()).incognitoAllowed)
        throw new Error("incognito not allowed: enable “Allow in Incognito” for fearch bridge at chrome://extensions");
      const windowId = await ensureWindow(!!job.incognito);
      const tab = await chrome.tabs.create({ windowId, url: job.url, active: false });
      ownedTabs.add(tab.id);
      await dropStarterTab(windowId);
      await waitLoaded(tab.id, job.timeoutMs || 20000);
      await settle(tab.id, job.settleSelector, job.settleMs || 4000);
      const snap = await snapshot(tab.id);
      return { ok: true, tabId: tab.id, ...snap };
    }
    case "read": {
      if (!ownedTabs.has(job.tabId)) throw new Error("not a fearch tab");
      return { ok: true, tabId: job.tabId, ...(await snapshot(job.tabId)) };
    }
    case "activate": {
      // Show the tab and ask for attention (dock/taskbar), but never take focus away from whatever
      // the person is doing: fearch reports that a check is waiting; the person comes to it.
      if (!ownedTabs.has(job.tabId)) throw new Error("not a fearch tab");
      const tab = await chrome.tabs.update(job.tabId, { active: true });
      await chrome.windows.update(tab.windowId, { state: "normal", drawAttention: true });
      return { ok: true };
    }
    case "close": {
      if (!ownedTabs.has(job.tabId)) return { ok: true };
      ownedTabs.delete(job.tabId);
      let windowId = null;
      try {
        windowId = (await chrome.tabs.get(job.tabId)).windowId;
      } catch {}
      await chrome.tabs.remove(job.tabId).catch(() => {});
      if (windowId !== null) await closeWindowIfEmpty(windowId);
      return { ok: true };
    }
    default:
      throw new Error(`unknown op ${job.op}`);
  }
}

async function loop(port) {
  if (loops.get(port)) return;
  loops.set(port, true);
  try {
    await tokenReady;
    for (;;) {
      let job;
      let nonce;
      try {
        nonce = newNonce();
        const r = await fetch(`http://127.0.0.1:${port}/fearch/next`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            ...(await hello()),
            nonce,
            auth: TOKEN ? await sha256hex(`${TOKEN}:poll:${nonce}`) : undefined,
          }),
        });
        if (r.status === 204) {
          state.servers[port] = { connected: true, at: Date.now() };
          continue;
        }
        if (r.status === 403) {
          const body = await r.json().catch(() => null);
          state.lastError = (body && body.error) || "not paired — run `fearch extension install`";
          state.servers[port] = { connected: false, unpaired: true, at: Date.now() };
          await sleep(5000);
          continue;
        }
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        state.servers[port] = { connected: true, at: Date.now() };
        job = await r.json();
      } catch (e) {
        state.servers[port] = { connected: false, at: Date.now() };
        await sleep(3000);
        continue;
      }
      let result;
      // Execute nothing a paired fearch server did not provably send: whoever holds the port must
      // echo a SHA-256 over our nonce and the job id, which only a token holder can compute.
      if (!TOKEN || job.proof !== (await sha256hex(`${TOKEN}:job:${nonce}:${job.id}`))) {
        state.lastError = "server failed the pairing proof; job refused";
        state.servers[port] = { connected: false, unpaired: true, at: Date.now() };
        await sleep(5000);
        continue;
      }
      try {
        result = await handle(job);
      } catch (e) {
        result = { ok: false, error: String(e && e.message ? e.message : e) };
        state.lastError = result.error;
      }
      try {
        await fetch(`http://127.0.0.1:${port}/fearch/result`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ id: job.id, ...result, auth: await sha256hex(`${TOKEN}:result:${job.id}`) }),
        });
      } catch {}
    }
  } finally {
    loops.delete(port);
  }
}

function startAll() {
  for (const p of PORTS) loop(p);
}

chrome.runtime.onInstalled.addListener(startAll);
chrome.runtime.onStartup.addListener(startAll);
chrome.alarms.create("fearch-tick", { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((a) => a.name === "fearch-tick" && startAll());
chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (msg && msg.type === "status") {
    hello().then((h) => reply({ ...h, servers: state.servers, lastError: state.lastError, ownedTabs: ownedTabs.size }));
    return true;
  }
});
startAll();
