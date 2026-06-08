/**
 * content.js — Isolated world content script
 *
 * Responsibilities:
 *  - Displays REC badge on target page while recording
 *  - Shows toast notifications for each captured API call
 *  - Relays RECORDING_STARTED/STOPPED messages from background
 *
 * Note: Runs in ISOLATED world — cannot access page JS.
 * API interception is done via CDP in background.js, not here.
 */

(function () {
  if (window.__apiRecorderIsolatedInjected) return;
  window.__apiRecorderIsolatedInjected = true;

  /* ── REC badge overlay ───────────────────────────────────────── */
  const badge = document.createElement("div");
  badge.style.cssText = "position:fixed;bottom:16px;right:16px;z-index:2147483647;background:#1a1a1a;color:#fff;font-size:11px;font-weight:600;padding:5px 12px;border-radius:20px;display:none;align-items:center;gap:6px;pointer-events:none;font-family:system-ui,sans-serif";
  badge.textContent = "⏺ REC";
  document.documentElement.appendChild(badge);

  /* ── Toast overlay ───────────────────────────────────────────── */
  const overlay = document.createElement("div");
  overlay.style.cssText = "position:fixed;top:12px;right:12px;z-index:2147483647;display:flex;flex-direction:column;gap:6px;pointer-events:none;max-width:380px;font-family:system-ui,sans-serif";
  document.documentElement.appendChild(overlay);

  const MBG = { GET:"#E6F1FB",POST:"#EAF3DE",PUT:"#FAEEDA",DELETE:"#FCEBEB",PATCH:"#EEEDFE" };
  const MFG = { GET:"#185FA5",POST:"#3B6D11",PUT:"#854F0B",DELETE:"#A32D2D",PATCH:"#534AB7" };

  function showToast({ method, url, status, ms }) {
    let shortUrl;
    try { const u = new URL(url); shortUrl = u.pathname + (u.search || ""); }
    catch (_) { shortUrl = url.length > 50 ? "…" + url.slice(-47) : url; }

    const t = document.createElement("div");
    t.style.cssText = "background:rgba(10,10,10,0.92);color:#f0f0f0;border-radius:8px;padding:8px 12px;border-left:3px solid "+(status>=400?"#E24B4A":"#1D9E75")+";opacity:0;transform:translateX(14px);transition:opacity .15s,transform .15s";

    const row = document.createElement("div");
    row.style.cssText = "display:flex;align-items:center;gap:6px;margin-bottom:3px";

    const mb = document.createElement("span");
    mb.style.cssText = "background:"+(MBG[method]||"#eee")+";color:"+(MFG[method]||"#333")+";font-size:10px;font-weight:700;padding:1px 6px;border-radius:4px";
    mb.textContent = method;

    const sb = document.createElement("span");
    sb.style.cssText = "font-size:11px;font-weight:700;color:"+(status>=400?"#F09595":"#5DCAA5");
    sb.textContent = status;

    const msEl = document.createElement("span");
    msEl.style.cssText = "font-size:10px;color:#888;margin-left:auto";
    msEl.textContent = ms + "ms";

    row.append(mb, sb, msEl);

    const urlDiv = document.createElement("div");
    urlDiv.style.cssText = "font-size:11px;color:#ccc;font-family:monospace;word-break:break-all";
    urlDiv.textContent = shortUrl;

    t.append(row, urlDiv);
    overlay.appendChild(t);
    requestAnimationFrame(() => { t.style.opacity="1"; t.style.transform="translateX(0)"; });
    setTimeout(() => { t.style.opacity="0"; setTimeout(() => t.remove(), 200); }, 3500);
  }

  /* ── Messages from background ────────────────────────────────── */
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === "RECORDING_STARTED") { badge.style.display = "flex"; }
    if (msg.type === "RECORDING_STOPPED") { badge.style.display = "none"; }
    if (msg.type === "API_EVENT") { showToast(msg.data); }
  });

})();
