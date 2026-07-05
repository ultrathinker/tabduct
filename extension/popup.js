// Tabduct popup — Connection + Sharing.

const $ = (id) => document.getElementById(id);
const send = (msg) => chrome.runtime.sendMessage(msg);

// ---- Connection ----
const LABELS = { disconnected: "Stopped", connecting: "Starting…", connected: "Running", error: "Error" };

chrome.storage.local.get("port").then(({ port }) => { if (port) $("port").value = port; });
$("port").addEventListener("input", () => {
  const n = Number($("port").value);
  if (Number.isInteger(n) && n >= 0 && n <= 65535) chrome.storage.local.set({ port: n });
});

function renderConn(s) {
  const state = s?.state ?? "disconnected";
  const connected = state === "connected";
  const text = s?.error ? `Error: ${s.error}` : (LABELS[state] ?? state);
  $("dot").dataset.state = state;
  $("dot").title = connected ? "Running — click to stop" : `${text} — click to start`;
  $("connArea").hidden = connected; // when connected, the header dot is the sole indicator
  $("shareArea").hidden = !connected; // sharing is meaningless until connected
  $("toggle").disabled = state === "connecting";
  $("port").disabled = state === "connecting" || $("hub").checked; // port is irrelevant in hub mode
  $("status").dataset.state = state; // colour: red disconnected/error, green connected
  $("status").textContent = text;
  const show = connected && s?.token;
  $("creds").hidden = !show;
  if (show) { $("url").textContent = s.hub && s.endpoint ? s.endpoint : `http://127.0.0.1:${s.port}/mcp`; $("auth").textContent = `Bearer ${s.token}`; }
}

chrome.storage.local.get("useHub").then(({ useHub }) => { $("hub").checked = useHub !== false; }); // default on
$("hub").addEventListener("change", async () => renderConn(await send({ cmd: "setHub", on: $("hub").checked })));

async function toggleConn() {
  const s = await send({ cmd: "status" });
  if (s?.state === "connecting") return;
  if (s?.state === "connected") { renderConn(await send({ cmd: "disconnect" })); return; }
  const n = Number($("port").value);
  if (!Number.isInteger(n) || n < 0 || n > 65535) { renderConn({ state: "error", error: "invalid port" }); return; }
  renderConn(await send({ cmd: "connect", port: n }));
}
$("toggle").addEventListener("click", toggleConn);
$("dot").addEventListener("click", toggleConn);
$("dot").addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggleConn(); } });

// ---- Sharing ----
function host(url) { try { return new URL(url).host; } catch { return url || ""; } }

function renderSharing(s) {
  if (!s) return;
  const tier = s.tier ?? "none";
  $("countText").textContent = tier === "all" ? "ALL tabs" : `${s.sharedCount ?? 0} tab${s.sharedCount === 1 ? "" : "s"}`;
  $("countClear").hidden = !(tier === "all" || (s.sharedCount ?? 0) > 0);
  if (document.activeElement !== $("label")) $("label").value = s.label ?? "";
  $("tabGroup").checked = !!s.useTabGroup;
  $("readOnly").checked = !!s.readOnly;
  $("ttl").value = String(s.ttlMs || 0);
  $("lockToDomain").checked = s.lockToDomain !== false;
  $("noAutoShareOpened").checked = s.noAutoShareOpened !== false;
  // CDP opt-ins (PART 4) — always visible indicator (chip) when the powerful path is on.
  $("allowCdp").checked = !!s.allowCdp;
  $("cdpAlways").checked = !!s.cdpAlways;
  $("cdpAlways").disabled = !s.allowCdp; // sub-option meaningful only when the master is on
  $("cdpConsole").checked = !!s.cdpConsole;
  $("cdpConsole").disabled = !s.allowCdp; // meaningful only when the master is on (like cdpAlways)
  // Header chip: hidden when CDP is off; amber when the capability is enabled
  // (attaches only on demand); red when a developer-mode sub-option keeps the
  // debugger attached continuously. Each state carries its own explaining hint.
  const cdpOn = !!s.allowCdp;
  const cdpDev = cdpOn && (!!s.cdpAlways || !!s.cdpConsole);
  const chip = $("cdpChip");
  chip.hidden = !cdpOn;
  chip.classList.toggle("cdp-chip-dev", cdpDev);
  chip.title = cdpDev
    ? "⚠ CDP DEVELOPER MODE (red): 'Always use CDP' and/or 'Capture full console via CDP' is on, so the debugger stays ATTACHED to shared tabs continuously and Chrome's 'being debugged' banner stays up the whole time — heavier and more intrusive than on-demand use. Turn those sub-options off to drop back to on-demand (amber), or turn off 'Allow CDP eval' to disable CDP entirely."
    : "CDP ENABLED (amber): the 'Allow CDP eval' toggle is on. This is a capability indicator, not live usage — nothing attaches until an eval actually needs CDP (e.g. a strict-CSP site), and the banner only appears while it's briefly in use. Turn the toggle off to hide this chip.";
  // Origin list MODE: block (default) → list is a denylist; allow → only listed hosts shared.
  const allow = s.originMode === "allow";
  $("originMode").value = allow ? "allow" : "block";
  $("denyHeading").textContent = allow ? "Allowed origins" : "Blocked origins";
  $("denyHint").hidden = !(allow && !(s.denyOrigins ?? []).length);
  const all = tier === "all";
  const activeShared = !all && (s.tabs ?? []).some((t) => t.id === s.activeTabId);
  $("shareThis").hidden = all;
  $("allBadge").hidden = !all;
  $("shareThis").textContent = activeShared ? "Unshare Current Tab" : "Share Current Tab";
  $("shareThis").classList.toggle("on", activeShared);
  $("shareEvery").textContent = all ? "Unshare Everything" : "Share Everything";
  $("shareEvery").classList.toggle("on", all);
  $("revokeAll").hidden = all || (s.sharedCount ?? 0) === 0;

  const ul = $("shared"); ul.innerHTML = ""; ul.hidden = all;
  if (!all) for (const t of s.tabs ?? []) {
    const li = document.createElement("li");
    const img = document.createElement("img"); img.className = "fav"; img.src = t.favIconUrl || "icons/16.png"; img.onerror = () => (img.src = "icons/16.png");
    const span = document.createElement("span"); span.className = "ttl"; span.title = t.url; span.textContent = t.title || host(t.url);
    span.onclick = () => send({ cmd: "sharing.activate", tabId: t.id });
    const x = document.createElement("button"); x.className = "x"; x.textContent = "✕"; x.title = "unshare";
    x.onclick = async () => renderSharing(await send({ cmd: "sharing.unshare", tabId: t.id }));
    li.append(img, span, x); ul.appendChild(li);
  }

  const dl = $("denyList"); dl.innerHTML = "";
  for (const rule of s.denyOrigins ?? []) {
    const li = document.createElement("li");
    const span = document.createElement("span"); span.className = "ttl"; span.textContent = rule;
    const x = document.createElement("button"); x.className = "x"; x.textContent = "✕";
    x.onclick = async () => renderSharing(await send({ cmd: "sharing.setDeny", list: (s.denyOrigins ?? []).filter((r) => r !== rule) }));
    li.append(span, x); dl.appendChild(li);
  }
}

$("shareThis").addEventListener("click", async () => renderSharing(await send({ cmd: "sharing.toggleActive" })));
$("shareEvery").addEventListener("click", async () => {
  const s = await send({ cmd: "sharing.status" });
  if (s?.tier === "all") { renderSharing(await send({ cmd: "sharing.tier", tier: "none" })); return; }
  if (!confirm("Share EVERY tab (current and future) with the agent?")) return;
  renderSharing(await send({ cmd: "sharing.tier", tier: "all" }));
});
$("countClear").addEventListener("click", async () => {
  const s = await send({ cmd: "sharing.status" });
  if (s?.tier === "all") renderSharing(await send({ cmd: "sharing.tier", tier: "none" })); // same as Unshare Everything
  else renderSharing(await send({ cmd: "sharing.revokeAll" }));                            // same as Revoke all
});
$("readOnly").addEventListener("change", async () => renderSharing(await send({ cmd: "sharing.setOptions", readOnly: $("readOnly").checked })));
$("ttl").addEventListener("change", async () => renderSharing(await send({ cmd: "sharing.setOptions", ttlMs: Number($("ttl").value) || 0 })));
$("lockToDomain").addEventListener("change", async () => renderSharing(await send({ cmd: "sharing.setOptions", lockToDomain: $("lockToDomain").checked })));
$("noAutoShareOpened").addEventListener("change", async () => renderSharing(await send({ cmd: "sharing.setOptions", noAutoShareOpened: $("noAutoShareOpened").checked })));
// CDP opt-in is a pure setting toggle. The "debugger" permission cannot be an
// optional/runtime permission (Chrome forbids it — chrome.permissions.request
// would silently return false with no prompt), so it is declared as a required
// permission and granted at install. Nothing attaches until allowCdp is on AND
// consent applies (sharing + not read-only); Chrome's "being debugged" banner is
// the real-time signal. Disabling clears cdpAlways/cdpConsole and tells the
// background to release any held sessions.
$("allowCdp").addEventListener("change", async () => {
  if ($("allowCdp").checked) {
    renderSharing(await send({ cmd: "sharing.setOptions", allowCdp: true }));
  } else {
    $("cdpAlways").checked = false;
    $("cdpConsole").checked = false;
    renderSharing(await send({ cmd: "sharing.setOptions", allowCdp: false, cdpAlways: false, cdpConsole: false }));
  }
});
$("cdpAlways").addEventListener("change", async () => renderSharing(await send({ cmd: "sharing.setOptions", cdpAlways: $("cdpAlways").checked })));
$("cdpConsole").addEventListener("change", async () => renderSharing(await send({ cmd: "sharing.setOptions", cdpConsole: $("cdpConsole").checked })));
$("originMode").addEventListener("change", async () => renderSharing(await send({ cmd: "sharing.setOriginMode", mode: $("originMode").value })));
$("revokeAll").addEventListener("click", async () => renderSharing(await send({ cmd: "sharing.revokeAll" })));
$("tabGroup").addEventListener("change", async () => renderSharing(await send({ cmd: "sharing.setTabGroup", on: $("tabGroup").checked })));
$("label").addEventListener("change", async () => renderSharing(await send({ cmd: "sharing.setLabel", label: $("label").value })));
$("denyAdd").addEventListener("click", async () => {
  const v = $("denyInput").value.trim(); if (!v) return;
  const s = await send({ cmd: "sharing.status" });
  renderSharing(await send({ cmd: "sharing.setDeny", list: [...(s.denyOrigins ?? []), v] }));
  $("denyInput").value = "";
});

// ---- Screenshot (manual capture → opens a viewer tab you can save from) ----
async function capture(fullPage) {
  const hint = $("shotHint");
  hint.hidden = false; hint.classList.remove("warn");
  hint.textContent = fullPage ? "Capturing full page…" : "Capturing…";
  $("shotVisible").disabled = true; $("shotFull").disabled = true;
  try {
    const res = await send({ cmd: "screenshot.capture", fullPage });
    if (res?.ok) { hint.textContent = "Opened in a new tab."; window.close(); }
    else { hint.classList.add("warn"); hint.textContent = `Failed: ${res?.error || "unknown error"}`; }
  } finally {
    $("shotVisible").disabled = false; $("shotFull").disabled = false;
  }
}
$("shotVisible").addEventListener("click", () => capture(false));
$("shotFull").addEventListener("click", () => capture(true));

// Live refresh (hotkey / background changes) + initial paint.
chrome.runtime.onMessage.addListener((m) => {
  if (m?.evt === "status") renderConn(m);
  if (m?.evt === "sharing") send({ cmd: "sharing.status" }).then(renderSharing);
});
// Layer switching: main ⇄ Settings (two-column, widened) ⇄ How-it-works.
// Each helper owns exactly one body-width class so leaving a layer always
// restores the popup width (PART 5).
const header = document.querySelector("header");
const showMain = () => { document.body.classList.remove("wide", "wide-settings"); header.hidden = false; $("main").hidden = false; $("settings").hidden = true; $("howto").hidden = true; window.scrollTo(0, 0); };
const showSettings = () => { document.body.classList.remove("wide"); document.body.classList.add("wide-settings"); header.hidden = false; $("main").hidden = true; $("settings").hidden = false; $("howto").hidden = true; window.scrollTo(0, 0); };
const showHowto = () => { document.body.classList.remove("wide-settings"); document.body.classList.add("wide"); header.hidden = true; $("main").hidden = true; $("settings").hidden = true; $("howto").hidden = false; window.scrollTo(0, 0); };
$("gear").addEventListener("click", showSettings);
$("back").addEventListener("click", showMain);
$("howBtn").addEventListener("click", showHowto);
$("howClose").addEventListener("click", showSettings);

send({ cmd: "status" }).then(renderConn);
send({ cmd: "sharing.status" }).then(renderSharing);
