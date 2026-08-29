chrome.runtime.sendMessage({ type: "status" }, (s) => {
  const el = document.getElementById("s");
  if (!s) { el.textContent = "bridge not running"; return; }
  const live = Object.entries(s.servers || {}).filter(([, v]) => v.connected && Date.now() - v.at < 40000).map(([p]) => p);
  el.innerHTML =
    (live.length ? `<div class="ok">✔ connected to fearch on port ${live.join(", ")}</div>` : `<div class="no">✘ no fearch server found — start fearch (or run <code>fearch extension status</code>)</div>`) +
    `<ul><li>version ${s.version}</li><li>incognito: ${s.incognitoAllowed ? "allowed" : "not allowed (toggle “Allow in Incognito” at chrome://extensions to use --incognito)"}</li><li>open tabs: ${s.ownedTabs}</li>${s.lastError ? `<li class="no">last error: ${s.lastError}</li>` : ""}</ul>`;
});
