// Tabduct screenshot viewer — shows the just-captured image (thick red frame so it's
// clearly a screenshot, not the live page) with a Download link above; right-click gives
// Chrome's native Save/Copy. The image is fetched from the service worker IN MEMORY
// (screenshot.get) — no chrome.storage quota to hit on large PNGs.
//
// Sizing is in PIXELS (not vw/vh) so Ctrl+mouse-wheel browser zoom actually enlarges the
// image. On load it's fit to ~90% of the window WIDTH; click toggles fit ↔ actual (100%) size.

(async () => {
  const img = document.getElementById("img");
  const msg = document.getElementById("msg");
  const dl = document.getElementById("dl");
  const k = new URLSearchParams(location.search).get("k");

  let v = null;
  try { v = await chrome.runtime.sendMessage({ cmd: "screenshot.get", k }); } catch {}
  if (!v || !v.dataUrl) {
    msg.hidden = false;
    msg.textContent = "No screenshot found (it may have expired — capture again from the Tabduct popup).";
    return;
  }

  const ext = v.mimeType === "image/jpeg" ? "jpg" : "png";
  const safeTitle = (v.title || "tab").replace(/[^\w.-]+/g, "_").slice(0, 40) || "tab";
  dl.href = v.dataUrl;
  dl.download = `tabduct-${safeTitle}-${v.ts}.${ext}`;
  dl.hidden = false;

  document.title = `Screenshot — ${v.title || v.url || "tab"}`;

  // Fit to ~90% of the window WIDTH (never upscale past natural size). Pixel width so
  // browser zoom works; a tall shot scrolls vertically.
  const fit = () => {
    const availW = Math.max(1, window.innerWidth * 0.9);
    const scale = Math.min(availW / img.naturalWidth, 1);
    img.style.width = Math.round(img.naturalWidth * scale) + "px";
    img.classList.remove("actual");
  };
  img.addEventListener("load", fit, { once: true });
  img.addEventListener("click", () => {
    if (img.classList.contains("actual")) { fit(); }
    else { img.style.width = img.naturalWidth + "px"; img.classList.add("actual"); } // 100% for pixel-level inspection
  });
  window.addEventListener("resize", () => { if (!img.classList.contains("actual")) fit(); });

  img.src = v.dataUrl;
  img.hidden = false;
})();
