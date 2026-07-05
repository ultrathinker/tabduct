// Tabduct screenshot viewer — reads the one-shot image the background stored in
// session storage, shows it, and offers a Download link. Cleared after load so a
// refresh doesn't resurrect a stale capture.

(async () => {
  const img = document.getElementById("img");
  const meta = document.getElementById("meta");
  const dl = document.getElementById("dl");
  // Read exactly this capture's key (?k=<ts>); fall back to the legacy shared key.
  const k = new URLSearchParams(location.search).get("k");
  const key = k ? `screenshotView_${k}` : "screenshotView";
  const store = await chrome.storage.session.get(key);
  const v = store[key];
  if (!v || !v.dataUrl) { meta.textContent = "No screenshot found (it may have expired — capture again from the Tabduct popup)."; return; }

  img.src = v.dataUrl; img.hidden = false;
  const ext = v.mimeType === "image/jpeg" ? "jpg" : "png";
  const safeTitle = (v.title || "tab").replace(/[^\w.-]+/g, "_").slice(0, 40) || "tab";
  dl.href = v.dataUrl;
  dl.download = `tabduct-${safeTitle}-${v.ts}.${ext}`;
  dl.hidden = false;

  const bits = [v.fullPage ? `full page (${v.via})` : "visible area"];
  if (v.capturedHeightPx) bits.push(`${v.capturedHeightPx}px tall`);
  if (v.truncated) bits.push("⚠ truncated — page taller than the height cap");
  meta.textContent = bits.join(" · ");
  if (v.truncated) meta.classList.add("warn");
  document.title = `Screenshot — ${v.title || v.url || "tab"}`;

  // One-shot: drop it so a page refresh doesn't redisplay a stale image.
  chrome.storage.session.remove(key);
})();
