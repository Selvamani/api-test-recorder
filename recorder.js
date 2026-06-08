let isRecording = false;
let startTime   = null;
let timerInterval = null;
let entries     = [];
let filter      = "all";
let selectedId  = null;
let mediaRecorder  = null;
let recordedChunks = [];
let captureStream  = null;
let finalVideoBlob = null;  // stored after stop for HTML export
let recordedMime   = "video/webm";  // actual MediaRecorder mime (mp4 when supported)

const METHOD_COLORS = {
  GET:    ["#0D1F35","#378ADD"],
  POST:   ["#0A1F14","#1D9E75"],
  PUT:    ["#241800","#EF9F27"],
  DELETE: ["#2A0A0A","#E24B4A"],
  PATCH:  ["#1C1530","#7F77DD"],
};

const WS_STYLE = {
  connected: { bg:"#0A1F14", fg:"#1D9E75", label:"WS ⇌" },
  closed:    { bg:"#1a1a1a", fg:"#555",    label:"WS ✕" },
  sent:      { bg:"#0D1F35", fg:"#378ADD", label:"WS ↑" },
  received:  { bg:"#1C1530", fg:"#7F77DD", label:"WS ↓" },
  error:     { bg:"#2A0A0A", fg:"#E24B4A", label:"WS !" },
};

/* ── Static button wiring ────────────────────────────────────── */
document.getElementById("btnStart").addEventListener("click", startRecording);
document.getElementById("btnStop").addEventListener("click", stopRecording);
document.getElementById("btnClear").addEventListener("click", clearAll);
document.getElementById("btnExportJSON").addEventListener("click", exportJSON);
document.getElementById("btnExportHTML").addEventListener("click", exportHTML);
document.getElementById("btnAddNote").addEventListener("click", addNote);
document.getElementById("copyBtn").addEventListener("click", copyDetailJSON);
document.getElementById("noteInput").addEventListener("keydown", e => { if (e.key === "Enter") addNote(); });
document.querySelectorAll(".ftab").forEach(tab => {
  tab.addEventListener("click", () => setFilter(tab.dataset.filter, tab));
});
// One delegated click listener for the whole timeline — avoids re-attaching a
// listener per entry on every render (which froze the page under WS floods).
document.getElementById("timeline").addEventListener("click", (ev) => {
  const el = ev.target.closest(".entry");
  if (el && el.dataset.id) openDetail(el.dataset.id);
});

/* ── Background messages ─────────────────────────────────────── */
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === "API_EVENT" && isRecording) {
    pushEntry({ ...msg.data, kind: msg.data.kind || "http", id: uid(), note: "" });
  }
  if (msg.type === "ATTACH_ERROR") {
    showError("Could not attach the recorder to the target tab" +
      (msg.error ? " (" + msg.error + ")" : "") +
      ". If Chrome DevTools is open on that tab, close it — Chrome only allows one debugger per tab — then Stop and Start again.");
  }
  // Start/Stop driven from the toolbar popup.
  if (msg.type === "POPUP_START" && !isRecording) startRecording();
  if (msg.type === "POPUP_STOP"  &&  isRecording) stopRecording();
});

/* ── Recording ───────────────────────────────────────────────── */
async function startRecording() {
  showError("");
  document.getElementById("btnStart").disabled = true;

  chrome.runtime.sendMessage({ type: "GET_STREAM_ID" }, async (res) => {
    if (!res || !res.ok) {
      showError("Could not get stream ID: " + (res?.error || "Navigate to target page first."));
      document.getElementById("btnStart").disabled = false;
      return;
    }
    try {
      captureStream = await navigator.mediaDevices.getUserMedia({
        video: { mandatory: { chromeMediaSource:"tab", chromeMediaSourceId:res.streamId, maxWidth:1920, maxHeight:1080, maxFrameRate:30 } },
        audio: { mandatory: { chromeMediaSource:"tab", chromeMediaSourceId:res.streamId } }
      });
    } catch (err) {
      showError("getUserMedia failed: " + err.message);
      document.getElementById("btnStart").disabled = false;
      return;
    }

    recordedChunks = [];
    // Prefer MP4 (H.264+AAC) — plays everywhere; Chrome 130+ can mux it.
    // Fall back to WebM on older Chrome / unsupported codecs.
    const mimeType = [
      "video/mp4;codecs=avc1.42E01E,mp4a.40.2",
      "video/mp4",
      "video/webm;codecs=vp9,opus",
      "video/webm;codecs=vp8,opus",
      "video/webm"
    ].find(t => MediaRecorder.isTypeSupported(t)) || "video/webm";
    recordedMime = mimeType;

    mediaRecorder = new MediaRecorder(captureStream, { mimeType });
    mediaRecorder.ondataavailable = e => { if (e.data.size > 0) recordedChunks.push(e.data); };
    mediaRecorder.onerror = e => showError("MediaRecorder error: " + e.error?.message);
    mediaRecorder.start(1000);

    isRecording = true;
    startTime   = Date.now();
    timerInterval = setInterval(tickTimer, 1000);
    setRecUI(true);
    chrome.runtime.sendMessage({ type: "RECORDING_STARTED" });
  });
}

function stopRecording() {
  if (!isRecording) return;
  isRecording = false;
  clearInterval(timerInterval);
  setRecUI(false);
  chrome.runtime.sendMessage({ type: "RECORDING_STOPPED" });

  if (mediaRecorder && mediaRecorder.state !== "inactive") {
    mediaRecorder.onstop = async () => {
      const isMp4 = recordedMime.startsWith("video/mp4");
      // Use a clean container mime (no codecs) — a comma in "codecs=avc1,mp4a"
      // would break the data: URI used when embedding the video in the report.
      finalVideoBlob = isMp4
        ? new Blob(recordedChunks, { type: "video/mp4" })
        : await makeSeekableWebM(recordedChunks);   // WebM gets duration/cues injected
      downloadBlob(finalVideoBlob, "screen-recording-" + Date.now() + (isMp4 ? ".mp4" : ".webm"));
    };
    mediaRecorder.stop();
  }
  if (captureStream) { captureStream.getTracks().forEach(t => t.stop()); captureStream = null; }
}

function setRecUI(on) {
  document.getElementById("recDot").className    = "rec-dot" + (on ? " on" : "");
  document.getElementById("recLabel").textContent = on ? "recording" : "stopped";
  document.getElementById("recLabel").className   = "rec-label" + (on ? " on" : "");
  document.getElementById("btnStart").disabled = on;
  document.getElementById("btnStop").disabled  = !on;
}

function tickTimer() {
  const s = Math.round((Date.now() - startTime) / 1000);
  document.getElementById("timer").textContent =
    String(Math.floor(s/60)).padStart(2,"0") + ":" + String(s%60).padStart(2,"0");
}

function showError(msg) {
  const el = document.getElementById("errBanner");
  el.textContent = msg;
  el.style.display = msg ? "block" : "none";
}

/* ── Entries ─────────────────────────────────────────────────── */
const MAX_DOM_ROWS = 4000;   // cap live DOM nodes; full data is kept in `entries` for export
let renderedIndex  = 0;      // how many of `entries` have been flushed to the DOM
let flushScheduled = false;
const stat = { http:0, s2xx:0, s4xx:0, s5xx:0, ws:0, notes:0, console:0, msSum:0, msCount:0 };

function pushEntry(e) {
  entries.push(e);
  tallyStat(e);
  scheduleFlush();
}

// Coalesce bursts (e.g. WS floods) into one DOM update per animation frame.
function scheduleFlush() {
  if (flushScheduled) return;
  flushScheduled = true;
  requestAnimationFrame(flushEntries);
}

function flushEntries() {
  flushScheduled = false;
  const tl = document.getElementById("timeline");
  let html = "";
  for (; renderedIndex < entries.length; renderedIndex++) {
    const e = entries[renderedIndex];
    if (matchesFilter(e)) html += entryHTML(e);
  }
  if (html) {
    const em = tl.querySelector(".empty-msg");
    if (em) em.remove();
    tl.insertAdjacentHTML("beforeend", html);
    while (tl.childElementCount > MAX_DOM_ROWS) tl.removeChild(tl.firstElementChild);
  }
  updateStats();
  autoScroll();
}

function tallyStat(e) {
  if (e.kind === "http") {
    stat.http++;
    if (e.status >= 200 && e.status < 300) stat.s2xx++;
    else if (e.status >= 400 && e.status < 500) stat.s4xx++;
    else if (e.status >= 500) stat.s5xx++;
    if (e.ms) { stat.msSum += e.ms; stat.msCount++; }
  } else if (e.kind === "ws") {
    if (e.event === "sent" || e.event === "received") stat.ws++;
  } else if (e.kind === "note") stat.notes++;
  else if (e.kind === "console") stat.console++;
}

function addNote() {
  const v = document.getElementById("noteInput").value.trim();
  if (!v) return;
  pushEntry({ id:uid(), kind:"note", text:v, ts:Date.now() });
  document.getElementById("noteInput").value = "";
}

function setFilter(f, el) {
  filter = f;
  document.querySelectorAll(".ftab").forEach(t => t.classList.remove("active"));
  el.classList.add("active");
  renderTimeline();
}

function clearAll() {
  if (entries.length && !confirm("Clear all entries?")) return;
  entries = []; selectedId = null; renderedIndex = 0;
  Object.keys(stat).forEach(k => stat[k] = 0);
  updateStats(); renderTimeline();
  document.getElementById("detailTitle").textContent = "Select an entry to inspect";
  document.getElementById("detailBody").innerHTML = "<div style='padding:3rem;text-align:center;color:#333;font-size:12px'>Click any entry in the timeline</div>";
  document.getElementById("copyBtn").style.display = "none";
}

// Only stick to the bottom if the user is already near it — don't yank them
// back down while they're scrolled up reading an earlier entry.
function autoScroll() {
  const t = document.getElementById("timeline");
  if (t.scrollHeight - t.scrollTop - t.clientHeight < 80) t.scrollTop = t.scrollHeight;
}

/* ── Stats ───────────────────────────────────────────────────── */
// Reads O(1) running counters maintained by tallyStat (no full-array scans).
function updateStats() {
  document.getElementById("sTotal").textContent = stat.http;
  document.getElementById("s2xx").textContent   = stat.s2xx;
  document.getElementById("s4xx").textContent   = stat.s4xx;
  document.getElementById("s5xx").textContent   = stat.s5xx;
  document.getElementById("sNotes").textContent = stat.notes + stat.ws;
  const consoleEl = document.getElementById("sConsole");
  if (consoleEl) consoleEl.textContent = stat.console;
  document.getElementById("sAvg").textContent = stat.msCount
    ? Math.round(stat.msSum / stat.msCount) + "ms" : "—";
}

/* ── Timeline ────────────────────────────────────────────────── */
function matchesFilter(e) {
  if (filter === "err")  return (e.kind === "http" && e.status >= 400) || (e.kind === "ws" && e.event === "error");
  if (filter === "note") return e.kind === "note";
  if (filter === "ws")   return e.kind === "ws";
  if (filter === "console") return e.kind === "console";
  return true;
}

// Full rebuild — used on filter change / clear / init. Per-entry appends during
// recording go through flushEntries() instead. Caps the DOM to the most recent
// MAX_DOM_ROWS matching entries (full data is still kept in `entries`).
function renderTimeline() {
  const tl  = document.getElementById("timeline");
  const vis = entries.filter(matchesFilter);

  if (!vis.length) {
    tl.innerHTML = "<div class='empty-msg'>" + (entries.length === 0
      ? "Start recording to capture API calls" : "No entries match filter") + "</div>";
    renderedIndex = entries.length;
    return;
  }

  const shown = vis.length > MAX_DOM_ROWS ? vis.slice(-MAX_DOM_ROWS) : vis;
  tl.innerHTML = shown.map(entryHTML).join("");
  renderedIndex = entries.length;
}

// Builds the HTML for one timeline entry (shared by renderTimeline + flushEntries).
function entryHTML(e) {
    const sel = e.id === selectedId ? " sel" : "";

    if (e.kind === "note") {
      return "<div class='entry note-e" + sel + "' data-id='" + e.id + "'>" +
        "<div class='erow'>" +
        "<span class='badge' style='background:#1C1530;color:#AFA9EC'>NOTE</span>" +
        "<span style='color:#b0a8e8;font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:200px'>" + esc(e.text) + "</span>" +
        "<span class='ets'>" + fmtTime(e.ts) + "</span>" +
        "</div></div>";
    }

    if (e.kind === "ws") {
      const s = WS_STYLE[e.event] || WS_STYLE.received;
      let shortUrl;
      try { const u = new URL(e.url); shortUrl = u.host + u.pathname; } catch (_) { shortUrl = e.url || ""; }
      shortUrl = shortUrl.length > 45 ? "…" + shortUrl.slice(-42) : shortUrl;
      let preview = "";
      if (e.payload != null) {
        const p = typeof e.payload === "string" ? e.payload : JSON.stringify(e.payload);
        preview = p.length > 60 ? p.slice(0,57) + "…" : p;
      }
      return "<div class='entry" + (e.event === "error" ? " err" : "") + sel + "' data-id='" + e.id + "'>" +
        "<div class='erow'>" +
        "<span class='badge' style='background:" + s.bg + ";color:" + s.fg + "'>" + s.label + "</span>" +
        "<span class='badge' style='background:#1a1a1a;color:#555;font-size:9px'>" + e.event.toUpperCase() + "</span>" +
        "<span class='ets'>" + fmtTime(e.ts) + "</span></div>" +
        "<div class='eurl'>" + esc(shortUrl) + "</div>" +
        (preview ? "<div style='font-size:10px;color:#444;font-family:monospace;margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis'>" + esc(preview) + "</div>" : "") +
        "</div>";
    }

    // Console
    if (e.kind === "console") {
      const CONSOLE_STYLE = {
        log:     { bg:"#1a1a1a", fg:"#888",    label:"LOG" },
        info:    { bg:"#0D1F35", fg:"#378ADD", label:"INFO" },
        warn:    { bg:"#241800", fg:"#EF9F27", label:"WARN" },
        warning: { bg:"#241800", fg:"#EF9F27", label:"WARN" },
        error:   { bg:"#2A0A0A", fg:"#E24B4A", label:"ERR" },
        debug:   { bg:"#1C1530", fg:"#7F77DD", label:"DBG" },
        verbose: { bg:"#1a1a1a", fg:"#555",    label:"VRB" },
      };
      const cs = CONSOLE_STYLE[e.level] || CONSOLE_STYLE.log;
      const preview = (e.text||"").length > 80 ? e.text.slice(0,77)+"…" : (e.text||"");
      return "<div class='entry" + (e.level==="error"?" err":"") + sel + "' data-id='" + e.id + "'>" +
        "<div class='erow'>" +
        "<span class='badge' style='background:" + cs.bg + ";color:" + cs.fg + ";font-family:monospace'>" + cs.label + "</span>" +
        "<span style='font-size:11px;color:#888;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:220px'>" + esc(preview) + "</span>" +
        "<span class='ets'>" + fmtTime(e.ts) + "</span>" +
        "</div></div>";
    }

    // HTTP
    const isErr = e.status >= 400;
    const [bg, fg] = METHOD_COLORS[e.method] || ["#1a1a1a","#888"];
    return "<div class='entry" + (isErr ? " err" : "") + sel + "' data-id='" + e.id + "'>" +
      "<div class='erow'>" +
      "<span class='badge' style='background:" + bg + ";color:" + fg + "'>" + e.method + "</span>" +
      "<span class='badge' style='background:" + (isErr?"#2A0A0A":"#0A1F14") + ";color:" + (isErr?"#F09595":"#5DCAA5") + "'>" + e.status + "</span>" +
      "<span style='font-size:10px;color:#444'>" + e.ms + "ms</span>" +
      "<span class='ets'>" + fmtTime(e.ts) + "</span></div>" +
      "<div class='eurl'>" + esc(shortPath(e.url)) + "</div></div>";
}

/* ── Detail ──────────────────────────────────────────────────── */
function openDetail(id) {
  // Move the highlight by toggling a class — not a full re-render (which under
  // WS floods made every click rebuild thousands of DOM nodes).
  const tl = document.getElementById("timeline");
  const prev = tl.querySelector(".entry.sel");
  if (prev) prev.classList.remove("sel");
  selectedId = id;
  const cur = tl.querySelector(".entry[data-id='" + id + "']");
  if (cur) cur.classList.add("sel");

  const e = entries.find(x => x.id === id);
  if (!e) return;

  document.getElementById("copyBtn").style.display = "inline-block";
  const titleEl = document.getElementById("detailTitle");
  const body    = document.getElementById("detailBody");

  if (e.kind === "note") {
    titleEl.textContent = "Note";
    body.innerHTML =
      "<div class='fb'><div class='fl'>annotation</div><div style='font-size:14px;color:#fff;line-height:1.5'>" + esc(e.text) + "</div></div>" +
      "<div class='fb'><div class='fl'>timestamp</div><div style='font-size:11px;color:#555;font-family:monospace'>" + new Date(e.ts).toISOString() + "</div></div>";
    return;
  }

  if (e.kind === "ws") {
    const s = WS_STYLE[e.event] || WS_STYLE.received;
    titleEl.textContent = s.label + " " + e.event.toUpperCase() + (e.idx !== undefined ? " #" + e.idx : "");
    body.innerHTML =
      "<div class='fb'><div class='fl'>url</div><div style='font-size:11px;color:#7EB8D4;font-family:monospace;word-break:break-all'>" + esc(e.url) + "</div></div>" +
      "<div style='display:flex;gap:6px;margin-bottom:14px;align-items:center'>" +
      "<span class='badge' style='background:" + s.bg + ";color:" + s.fg + "'>" + s.label + "</span>" +
      "<span class='badge' style='background:#1a1a1a;color:#555'>" + e.event.toUpperCase() + "</span>" +
      (e.idx !== undefined ? "<span style='font-size:10px;color:#444'>msg #" + e.idx + "</span>" : "") +
      "<span style='font-size:10px;color:#444'>" + new Date(e.ts).toISOString() + "</span></div>" +
      "<div class='fb'><div class='fl' style='display:flex;align-items:center;gap:8px'>payload" +
        "<button id='b64Btn' style='font-size:9px;font-weight:600;color:#9bdcc4;background:#0A1F14;border:1px solid #1D5C42;border-radius:3px;padding:1px 6px;cursor:pointer'>Decode base64</button>" +
      "</div><pre id='wsPayload'>" + esc(fmt(e.payload)) + "</pre></div>" +
      "<div class='fb'><div class='fl'>annotation</div><input class='ann-input' id='annInput' value='" + esc(e.note||"") + "' placeholder='Add a note…'></div>";
    document.getElementById("annInput").addEventListener("input", function() {
      const en = entries.find(x => x.id === id); if (en) en.note = this.value;
    });
    wireBase64Toggle(e.payload);
    return;
  }

  // Console
  if (e.kind === "console") {
    const CONSOLE_STYLE = {
      log:     { bg:"#1a1a1a", fg:"#888",    label:"LOG" },
      info:    { bg:"#0D1F35", fg:"#378ADD", label:"INFO" },
      warn:    { bg:"#241800", fg:"#EF9F27", label:"WARN" },
      warning: { bg:"#241800", fg:"#EF9F27", label:"WARN" },
      error:   { bg:"#2A0A0A", fg:"#E24B4A", label:"ERR" },
      debug:   { bg:"#1C1530", fg:"#7F77DD", label:"DBG" },
      verbose: { bg:"#1a1a1a", fg:"#555",    label:"VRB" },
    };
    const cs = CONSOLE_STYLE[e.level] || CONSOLE_STYLE.log;
    titleEl.textContent = cs.label + " · " + e.level.toUpperCase();
    body.innerHTML =
      "<div class='fb'><div class='fl'>message</div><pre style='color:" + cs.fg + "'>" + esc(e.text||"") + "</pre></div>" +
      (e.url ? "<div class='fb'><div class='fl'>source</div><div style='font-size:11px;color:#7EB8D4;font-family:monospace'>" + esc(e.url) + (e.lineNumber ? ":" + e.lineNumber : "") + "</div></div>" : "") +
      "<div class='fb'><div class='fl'>timestamp</div><div style='font-size:11px;color:#555;font-family:monospace'>" + new Date(e.ts).toISOString() + "</div></div>";
    return;
  }

  // HTTP
  titleEl.textContent = e.method + " " + e.status + " · " + e.ms + "ms";
  body.innerHTML =
    "<div class='fb'><div class='fl'>url</div><div style='font-size:11px;color:#7EB8D4;font-family:monospace;word-break:break-all;line-height:1.5'>" + esc(e.url) + "</div></div>" +
    "<div style='display:flex;gap:6px;margin-bottom:14px;flex-wrap:wrap;align-items:center'>" +
    "<span class='badge' style='background:" + (METHOD_COLORS[e.method]||["#1a1a1a","#888"])[0] + ";color:" + (METHOD_COLORS[e.method]||["#1a1a1a","#888"])[1] + "'>" + e.method + "</span>" +
    "<span class='badge' style='background:" + (e.status>=400?"#2A0A0A":"#0A1F14") + ";color:" + (e.status>=400?"#F09595":"#5DCAA5") + "'>" + e.status + "</span>" +
    "<span style='font-size:10px;color:#444'>" + new Date(e.ts).toISOString() + "</span></div>" +
    (e.reqBody != null ? "<div class='fb'><div class='fl'>request body</div><pre>" + esc(fmt(e.reqBody)) + "</pre></div>" : "") +
    "<div class='fb'><div class='fl'>response body</div><pre>" + esc(fmt(e.resBody)) + "</pre></div>" +
    "<div class='fb'><div class='fl'>annotation</div><input class='ann-input' id='annInput' value='" + esc(e.note||"") + "' placeholder='Add a note for this call…'></div>";
  document.getElementById("annInput").addEventListener("input", function() {
    const en = entries.find(x => x.id === id); if (en) en.note = this.value;
  });
}

function copyDetailJSON() {
  const e = entries.find(x => x.id === selectedId);
  if (e) navigator.clipboard.writeText(JSON.stringify(e, null, 2));
}

/* ── Export JSON ─────────────────────────────────────────────── */
function exportJSON() {
  const blob = new Blob([JSON.stringify({
    session: { start: startTime ? new Date(startTime).toISOString() : null, exported: new Date().toISOString() },
    entries
  }, null, 2)], { type: "application/json" });
  downloadBlob(blob, "api-session-" + Date.now() + ".json");
}


/* ── Export HTML — fully self-contained offline viewer ───────── */
async function exportHTML() {
  const btn = document.getElementById("btnExportHTML");
  const origText = btn.textContent;
  btn.textContent = "Building…";
  btn.disabled = true;
  await new Promise(r => setTimeout(r, 50)); // let UI update

  try {
    await _doExportHTML();
  } finally {
    btn.textContent = origText;
    btn.disabled = false;
  }
}

async function _doExportHTML() {
  const httpEntries    = entries.filter(e => e.kind === "http");
  const wsEntries      = entries.filter(e => e.kind === "ws" && (e.event === "sent" || e.event === "received"));
  const consoleEntries = entries.filter(e => e.kind === "console");
  const noteEntries    = entries.filter(e => e.kind === "note");

  // Convert recording to base64 for embedding
  let videoSrc = "";
  try {
    const blob = finalVideoBlob
      ? finalVideoBlob
      : (recordedChunks.length > 0
          ? (recordedMime.startsWith("video/mp4")
              ? new Blob(recordedChunks, { type: "video/mp4" })
              : await makeSeekableWebM(recordedChunks))
          : null);
    if (blob) videoSrc = await blobToBase64(blob);
  } catch (_) {}

  // The JSON is interpolated raw into the <script> below, so it must NOT be
  // re-escaped for the template literal (that doubled backslashes and broke
  // every body containing \" or \n). Only neutralize sequences that are unsafe
  // inside a <script> element: "</script>"/"<!--" and the U+2028/U+2029 line
  // separators (valid in JSON, illegal in a JS string literal pre-ES2019).
  const sessionData = JSON.stringify(entries)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
  const generated   = new Date().toLocaleString().replace(/`/g,"'");
  const duration    = startTime ? Math.round((Date.now() - startTime) / 1000) : 0;

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>API Test Report — ${generated}</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#0c0c0c;color:#e0e0e0;height:100vh;display:flex;flex-direction:column;overflow:hidden}
.topbar{background:#111;border-bottom:1px solid #1e1e1e;padding:8px 16px;display:flex;align-items:center;gap:10px;flex-shrink:0;flex-wrap:wrap}
.logo{font-size:13px;font-weight:700;color:#fff}.logo span{color:#1D9E75}
.dlbtn{font-size:10px;font-weight:600;color:#9bdcc4;background:#0A1F14;border:1px solid #1D5C42;border-radius:4px;padding:3px 9px;cursor:pointer;white-space:nowrap}
.dlbtn:hover{background:#0e2a1d;color:#c6f0e0}
.tabs-bar{display:flex;gap:0;background:#0e0e0e;border-bottom:1px solid #1e1e1e;flex-shrink:0}
.main-tab{padding:8px 18px;font-size:11px;font-weight:600;color:#555;cursor:pointer;border-bottom:2px solid transparent;letter-spacing:.3px}
.main-tab:hover{color:#aaa}.main-tab.active{color:#fff;border-bottom-color:#1D9E75}
.stats{display:flex;gap:0;background:#0e0e0e;border-bottom:1px solid #1e1e1e;flex-shrink:0;flex-wrap:wrap}
.stat{padding:5px 12px;border-right:1px solid #1a1a1a;text-align:center}
.stat:last-child{border-right:none}
.stat-n{font-size:14px;font-weight:600;color:#fff}.stat-l{font-size:9px;color:#444;margin-top:1px}
/* Tab panels */
.tab-panel{display:none;flex:1;overflow:hidden}
.tab-panel.active{display:flex}
/* Timeline tab — 3 column */
.tl-left{width:300px;flex-shrink:0;border-right:1px solid #1e1e1e;display:flex;flex-direction:column;overflow:hidden}
.tl-mid{flex:1;display:flex;flex-direction:column;overflow:hidden;border-right:1px solid #1e1e1e}
.tl-right{width:340px;flex-shrink:0;display:flex;flex-direction:column;overflow:hidden}
/* Network tab */
.net-panel{flex:1;display:flex;flex-direction:column;overflow:hidden}
.net-toolbar{padding:6px 12px;background:#0e0e0e;border-bottom:1px solid #1e1e1e;display:flex;align-items:center;gap:8px;flex-shrink:0;flex-wrap:wrap}
.net-search{background:#1a1a1a;border:1px solid #2a2a2a;border-radius:4px;padding:3px 8px;color:#e0e0e0;font-size:11px;width:180px;outline:none}
.net-search:focus{border-color:#444}
.nftab{font-size:10px;padding:2px 8px;border-radius:3px;cursor:pointer;color:#555;font-weight:500;border:1px solid transparent;background:none}
.nftab:hover{color:#aaa}.nftab.active{background:#1e1e1e;color:#ccc;border-color:#2a2a2a}
.net-table-wrap{flex:1;overflow:auto}
.net-table-wrap::-webkit-scrollbar{width:6px;height:6px}.net-table-wrap::-webkit-scrollbar-thumb{background:#2a2a2a}
.net-table{width:100%;border-collapse:collapse;font-size:11px;table-layout:fixed}
.net-table th{padding:5px 8px;background:#0e0e0e;color:#555;font-weight:600;text-transform:uppercase;font-size:9px;letter-spacing:.4px;border-bottom:1px solid #1e1e1e;position:sticky;top:0;z-index:1;text-align:left;white-space:nowrap;cursor:pointer;user-select:none}
.net-table th:hover{color:#aaa}
.net-table th.sorted-asc::after{content:" ↑"}.net-table th.sorted-desc::after{content:" ↓"}
.net-table td{padding:4px 8px;border-bottom:1px solid #141414;vertical-align:middle;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.net-table tr{cursor:pointer}.net-table tr:hover td{background:#141414}
.net-table tr.sel td{background:#141414;border-left:2px solid #1D9E75}
.net-table tr.err-row td{color:#F09595}.net-table tr.err-row:hover td{background:#1a0a0a}
.timing-bar{height:8px;border-radius:2px;min-width:2px;display:inline-block}
.net-detail{height:300px;flex-shrink:0;border-top:1px solid #1e1e1e;display:flex;flex-direction:column;overflow:hidden}
.net-detail-tabs{display:flex;gap:0;background:#0e0e0e;border-bottom:1px solid #1e1e1e;flex-shrink:0}
.det-tab{padding:5px 12px;font-size:10px;color:#555;cursor:pointer;border-bottom:2px solid transparent;font-weight:500}
.det-tab:hover{color:#aaa}.det-tab.active{color:#fff;border-bottom-color:#1D9E75}
.net-detail-body{flex:1;overflow:auto;padding:10px 14px;font-size:11px}
.net-detail-body::-webkit-scrollbar{width:4px}.net-detail-body::-webkit-scrollbar-thumb{background:#2a2a2a}
/* Shared */
.pane-hdr{padding:6px 12px;background:#0e0e0e;border-bottom:1px solid #1e1e1e;font-size:10px;font-weight:600;color:#555;text-transform:uppercase;letter-spacing:.5px;display:flex;align-items:center;gap:6px;flex-shrink:0}
.filter-tabs{display:flex;gap:2px;margin-left:auto}
.ftab{font-size:10px;padding:2px 6px;border-radius:3px;cursor:pointer;color:#555;font-weight:500;border:none;background:none}
.ftab:hover{color:#aaa}.ftab.active{background:#1e1e1e;color:#ccc}
.scroll{flex:1;overflow-y:auto}.scroll::-webkit-scrollbar{width:3px}.scroll::-webkit-scrollbar-thumb{background:#2a2a2a}
.entry{padding:6px 12px;border-left:2px solid transparent;cursor:pointer;border-bottom:1px solid #141414}
.entry:hover{background:#141414}.entry.sel{background:#141414;border-left-color:#1D9E75}
.entry.err{border-left-color:#E24B4A!important}.entry.note-e{border-left-color:#7F77DD}.entry.ws-e{border-left-color:#378ADD}.entry.con-e{border-left-color:#444}
.erow{display:flex;align-items:center;gap:4px}
.badge{font-size:9px;font-weight:700;padding:1px 5px;border-radius:3px;flex-shrink:0;letter-spacing:.3px;font-family:monospace}
.eurl{font-size:10px;color:#555;font-family:monospace;margin-top:1px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ets{font-size:10px;color:#333;margin-left:auto;flex-shrink:0}
.empty{padding:3rem 12px;text-align:center;color:#333;font-size:12px}
.video-wrap{flex:1;display:flex;flex-direction:column;background:#000;min-height:0}
video{width:100%;height:100%;object-fit:contain;background:#000}
.no-video{flex:1;display:flex;align-items:center;justify-content:center;color:#333;font-size:12px;text-align:center;padding:1rem}
.detail-body{flex:1;overflow-y:auto;padding:12px 14px;font-size:12px}
.detail-body::-webkit-scrollbar{width:3px}.detail-body::-webkit-scrollbar-thumb{background:#2a2a2a}
.fl{font-size:10px;color:#444;text-transform:uppercase;letter-spacing:.5px;margin-bottom:3px}
.fb{margin-bottom:12px}
pre{font-size:10px;font-family:monospace;background:#111;border:1px solid #1e1e1e;border-radius:5px;padding:8px;overflow-x:auto;white-space:pre-wrap;word-break:break-all;color:#7EB8D4;max-height:160px;overflow-y:auto;line-height:1.5}
</style>
</head>
<body>

<div class="topbar">
  <span class="logo">API <span>Recorder</span></span>
  <span style="font-size:11px;color:#444">|</span>
  <span style="font-size:11px;color:#666">${generated}</span>
  <span style="font-size:11px;color:#555;margin-left:auto;margin-right:6px">${httpEntries.length} HTTP · ${wsEntries.length} WS · ${consoleEntries.length} logs · ${noteEntries.length} notes · ${duration}s</span>
  <button class="dlbtn" onclick="downloadConsoleLogs()" title="Download console logs only as JSON">↓ Console logs</button>
  <button class="dlbtn" onclick="downloadNetworkJSON()" title="Download network requests/responses only as JSON">↓ Network JSON</button>
  <button class="dlbtn" onclick="downloadWebSocket()" title="Download WebSocket messages only as JSON (with base64-decoded payloads)">↓ WebSocket JSON</button>
</div>

<div class="stats">
  <div class="stat"><div class="stat-n">${httpEntries.length}</div><div class="stat-l">HTTP</div></div>
  <div class="stat"><div class="stat-n" style="color:#1D9E75">${httpEntries.filter(e=>e.status>=200&&e.status<300).length}</div><div class="stat-l">2xx ok</div></div>
  <div class="stat"><div class="stat-n" style="color:#E24B4A">${httpEntries.filter(e=>e.status>=400&&e.status<500).length}</div><div class="stat-l">4xx</div></div>
  <div class="stat"><div class="stat-n" style="color:#E24B4A">${httpEntries.filter(e=>e.status>=500).length}</div><div class="stat-l">5xx</div></div>
  <div class="stat"><div class="stat-n" style="color:#378ADD">${wsEntries.length}</div><div class="stat-l">WS msgs</div></div>
  <div class="stat"><div class="stat-n" style="color:#EF9F27">${consoleEntries.filter(e=>e.level==="warn"||e.level==="warning").length}</div><div class="stat-l">warnings</div></div>
  <div class="stat"><div class="stat-n" style="color:#E24B4A">${consoleEntries.filter(e=>e.level==="error").length}</div><div class="stat-l">errors</div></div>
  <div class="stat"><div class="stat-n" style="color:#7F77DD">${noteEntries.length}</div><div class="stat-l">notes</div></div>
</div>

<div class="tabs-bar">
  <div class="main-tab active" data-tab="timeline">Timeline</div>
  <div class="main-tab" data-tab="network">Network</div>
</div>

<!-- ── TIMELINE TAB ─────────────────────────────────────────── -->
<div class="tab-panel active" id="tab-timeline">
  <div class="tl-left">
    <div class="pane-hdr">
      Timeline
      <div class="filter-tabs">
        <button class="ftab active" onclick="setFilter('all',this)">All</button>
        <button class="ftab" onclick="setFilter('http',this)">HTTP</button>
        <button class="ftab" onclick="setFilter('err',this)">Err</button>
        <button class="ftab" onclick="setFilter('ws',this)">WS</button>
        <button class="ftab" onclick="setFilter('console',this)">Log</button>
        <button class="ftab" onclick="setFilter('note',this)">Notes</button>
      </div>
    </div>
    <div class="scroll" id="timeline"></div>
  </div>
  <div class="tl-mid">
    <div class="pane-hdr">Screen recording</div>
    <div class="video-wrap">
      ${videoSrc
        ? `<video id="vid" controls preload="auto"></video>`
        : `<div class="no-video">No screen recording in this session.<br><small>Start recording before testing to capture video.</small></div>`
      }
    </div>
  </div>
  <div class="tl-right">
    <div class="pane-hdr" id="detailTitle">Select an entry</div>
    <div class="detail-body" id="detailBody">
      <div class="empty">Click any entry in the timeline to inspect</div>
    </div>
  </div>
</div>

<!-- ── NETWORK TAB ──────────────────────────────────────────── -->
<div class="tab-panel" id="tab-network" style="flex-direction:column">
  <div class="net-panel">
    <div class="net-toolbar">
      <input class="net-search" id="netSearch" placeholder="Filter by URL…" oninput="renderNetwork()">
      <div style="display:flex;gap:4px">
        <button class="nftab active" data-nf="all"    onclick="setNetFilter('all',this)">All</button>
        <button class="nftab"        data-nf="fetch"  onclick="setNetFilter('fetch',this)">Fetch/XHR</button>
        <button class="nftab"        data-nf="2xx"    onclick="setNetFilter('2xx',this)">2xx</button>
        <button class="nftab"        data-nf="4xx"    onclick="setNetFilter('4xx',this)">4xx</button>
        <button class="nftab"        data-nf="5xx"    onclick="setNetFilter('5xx',this)">5xx</button>
        <button class="nftab"        data-nf="slow"   onclick="setNetFilter('slow',this)">Slow (&gt;500ms)</button>
      </div>
      <span id="netCount" style="font-size:10px;color:#555;margin-left:auto"></span>
    </div>
    <div class="net-table-wrap">
      <table class="net-table" id="netTable">
        <thead>
          <tr>
            <th style="width:50px"  onclick="sortNet('status')">Status</th>
            <th style="width:60px"  onclick="sortNet('method')">Method</th>
            <th                     onclick="sortNet('url')">URL</th>
            <th style="width:55px"  onclick="sortNet('ms')">Time</th>
            <th style="width:120px">Waterfall</th>
          </tr>
        </thead>
        <tbody id="netBody"></tbody>
      </table>
    </div>
    <div class="net-detail" id="netDetail" style="display:none">
      <div class="net-detail-tabs" id="netDetailTabs"></div>
      <div class="net-detail-body" id="netDetailBody"></div>
    </div>
  </div>
</div>

<script>
const ALL_ENTRIES = ${sessionData};
const START_TS    = ${startTime ? startTime : "null"};
const VIDEO_SRC   = ${videoSrc ? JSON.stringify(videoSrc) : "null"};

/* A base64 data: URI is not reliably seekable (no range requests), so convert
   it to a Blob URL once on load — that makes currentTime jumps consistent. */
(function initVideo(){
  if(!VIDEO_SRC) return;
  const vid=document.getElementById("vid"); if(!vid) return;
  // MediaRecorder output (WebM and fragmented MP4) often reports duration as
  // Infinity, which breaks the scrubber and seeking. Force the browser to
  // compute the real duration by seeking to the end once, then reset.
  vid.addEventListener("loadedmetadata", function fixDuration(){
    if(vid.duration===Infinity || !isFinite(vid.duration)){
      vid.currentTime=1e101;
      vid.addEventListener("timeupdate", function once(){
        vid.removeEventListener("timeupdate", once);
        vid.currentTime=0;
      });
    }
  });
  fetch(VIDEO_SRC).then(r=>r.blob()).then(b=>{ vid.src=URL.createObjectURL(b); })
    .catch(()=>{ vid.src=VIDEO_SRC; }); // fallback: data URI (still plays, seek may lag)
})();

const HTTP_ENTRIES = ALL_ENTRIES.filter(e => e.kind === "http");
const T_MIN = HTTP_ENTRIES.length ? Math.min(...HTTP_ENTRIES.map(e=>e.ts - e.ms)) : 0;
const T_MAX = HTTP_ENTRIES.length ? Math.max(...HTTP_ENTRIES.map(e=>e.ts)) : 1;
const T_SPAN = Math.max(T_MAX - T_MIN, 1);

const METHOD_COLORS = {
  GET:["#0D1F35","#378ADD"],POST:["#0A1F14","#1D9E75"],
  PUT:["#241800","#EF9F27"],DELETE:["#2A0A0A","#E24B4A"],PATCH:["#1C1530","#7F77DD"]
};
const WS_STYLE = {
  connected:{bg:"#0A1F14",fg:"#1D9E75",label:"WS ⇌"},closed:{bg:"#1a1a1a",fg:"#555",label:"WS ✕"},
  sent:{bg:"#0D1F35",fg:"#378ADD",label:"WS ↑"},received:{bg:"#1C1530",fg:"#7F77DD",label:"WS ↓"},error:{bg:"#2A0A0A",fg:"#E24B4A",label:"WS !"},
};
const CON_STYLE = {
  log:{bg:"#1a1a1a",fg:"#888",label:"LOG"},info:{bg:"#0D1F35",fg:"#378ADD",label:"INFO"},
  warn:{bg:"#241800",fg:"#EF9F27",label:"WARN"},warning:{bg:"#241800",fg:"#EF9F27",label:"WARN"},
  error:{bg:"#2A0A0A",fg:"#E24B4A",label:"ERR"},debug:{bg:"#1C1530",fg:"#7F77DD",label:"DBG"},verbose:{bg:"#1a1a1a",fg:"#555",label:"VRB"},
};
const STATUS_COLOR = s => s>=500?"#E24B4A":s>=400?"#EF9F27":s>=200?"#1D9E75":"#888";
const METHOD_FG    = m => (METHOD_COLORS[m]||["","#888"])[1];

function esc(s){return String(s||"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/'/g,"&#39;");}
function fmt(v){if(v==null)return"(empty)";try{return JSON.stringify(typeof v==="string"?JSON.parse(v):v,null,2);}catch(_){return String(v);}}
function fmtTime(ts){const d=new Date(ts);return d.toTimeString().slice(0,8)+"."+String(d.getMilliseconds()).padStart(3,"0");}

function b64ToText(str){var s=String(str).trim().replace(/\\s+/g,"");if(!s||!/^[A-Za-z0-9+/]+={0,2}$/.test(s))throw new Error("not base64");var bin=atob(s);var bytes=Uint8Array.from(bin,function(c){return c.charCodeAt(0);});return new TextDecoder().decode(bytes);}
function wireWsB64(payload){var btn=document.getElementById("wsB64Btn"),pre=document.getElementById("wsPayload");if(!btn||!pre)return;var rawStr=typeof payload==="string"?payload:JSON.stringify(payload),decoded=false;btn.addEventListener("click",function(){decoded=!decoded;if(decoded){try{pre.textContent=fmt(b64ToText(rawStr));}catch(_){pre.textContent="(payload is not valid base64)";}btn.textContent="Show raw";}else{pre.textContent=fmt(payload);btn.textContent="Decode base64";}});}

/* ── Main tabs ───────────────────────────────────────────────── */
document.querySelectorAll(".main-tab").forEach(t => {
  t.addEventListener("click", () => {
    document.querySelectorAll(".main-tab").forEach(x=>x.classList.remove("active"));
    document.querySelectorAll(".tab-panel").forEach(x=>x.classList.remove("active"));
    t.classList.add("active");
    document.getElementById("tab-"+t.dataset.tab).classList.add("active");
    if (t.dataset.tab === "network") renderNetwork();
  });
});

/* ── Timeline ────────────────────────────────────────────────── */
let currentFilter = "all";
let selectedId    = null;

function setFilter(f, el) {
  currentFilter = f;
  document.querySelectorAll(".ftab").forEach(t=>t.classList.remove("active"));
  el.classList.add("active");
  renderTimeline();
}

function renderTimeline() {
  const tl = document.getElementById("timeline");
  const vis = ALL_ENTRIES.filter(e => {
    if (currentFilter==="http")    return e.kind==="http";
    if (currentFilter==="err")     return (e.kind==="http"&&e.status>=400)||(e.kind==="ws"&&e.event==="error")||(e.kind==="console"&&e.level==="error");
    if (currentFilter==="ws")      return e.kind==="ws";
    if (currentFilter==="console") return e.kind==="console";
    if (currentFilter==="note")    return e.kind==="note";
    return true;
  });
  if (!vis.length){tl.innerHTML="<div class='empty'>No entries match this filter</div>";return;}
  tl.innerHTML=vis.map(e=>{
    const sel=e.id===selectedId?" sel":"";
    if(e.kind==="note")return"<div class='entry note-e"+sel+"' data-id='"+e.id+"'><div class='erow'><span class='badge' style='background:#1C1530;color:#AFA9EC'>NOTE</span><span style='color:#b0a8e8;font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:160px'>"+esc(e.text)+"</span><span class='ets'>"+fmtTime(e.ts)+"</span></div></div>";
    if(e.kind==="ws"){const s=WS_STYLE[e.event]||WS_STYLE.received;let su="";try{const u=new URL(e.url);su=u.host+u.pathname;}catch(_){su=e.url||"";}su=su.length>35?"…"+su.slice(-32):su;let pv="";if(e.payload!=null){const p=typeof e.payload==="string"?e.payload:JSON.stringify(e.payload);pv=p.length>50?p.slice(0,47)+"…":p;}return"<div class='entry ws-e"+(e.event==="error"?" err":"")+sel+"' data-id='"+e.id+"'><div class='erow'><span class='badge' style='background:"+s.bg+";color:"+s.fg+"'>"+s.label+"</span><span class='badge' style='background:#1a1a1a;color:#555;font-size:9px'>"+e.event.toUpperCase()+"</span><span class='ets'>"+fmtTime(e.ts)+"</span></div><div class='eurl'>"+esc(su)+"</div>"+(pv?"<div style='font-size:9px;color:#333;font-family:monospace;white-space:nowrap;overflow:hidden;text-overflow:ellipsis'>"+esc(pv)+"</div>":"")+"</div>";}
    if(e.kind==="console"){const cs=CON_STYLE[e.level]||CON_STYLE.log;const pv=(e.text||"").length>65?e.text.slice(0,62)+"…":(e.text||"");return"<div class='entry con-e"+(e.level==="error"?" err":"")+sel+"' data-id='"+e.id+"'><div class='erow'><span class='badge' style='background:"+cs.bg+";color:"+cs.fg+";font-family:monospace'>"+cs.label+"</span><span style='font-size:10px;color:#666;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:180px'>"+esc(pv)+"</span><span class='ets'>"+fmtTime(e.ts)+"</span></div></div>";}
    const isErr=e.status>=400;const[bg,fg]=METHOD_COLORS[e.method]||["#1a1a1a","#888"];let su="";try{const u=new URL(e.url);su=u.pathname+(u.search||"");}catch(_){su=e.url;}su=su.length>35?"…"+su.slice(-32):su;
    return"<div class='entry"+(isErr?" err":"")+sel+"' data-id='"+e.id+"'><div class='erow'><span class='badge' style='background:"+bg+";color:"+fg+"'>"+e.method+"</span><span class='badge' style='background:"+(isErr?"#2A0A0A":"#0A1F14")+";color:"+(isErr?"#F09595":"#5DCAA5")+"'>"+e.status+"</span><span style='font-size:9px;color:#444'>"+e.ms+"ms</span><span class='ets'>"+fmtTime(e.ts)+"</span></div><div class='eurl'>"+esc(su)+"</div></div>";
  }).join("");
  // One delegated listener (set once) instead of one per entry — keeps clicks
  // instant even with thousands of WS frames.
  tl.onclick=function(ev){var el=ev.target.closest(".entry");if(el&&el.dataset.id)openDetail(el.dataset.id);};
}

function openDetail(id) {
  // Move highlight via class toggle — NOT a full renderTimeline() rebuild
  // (which re-rendered every entry on each click and made WS-heavy reports lag).
  var _tl=document.getElementById("timeline");
  var _prev=_tl.querySelector(".entry.sel"); if(_prev)_prev.classList.remove("sel");
  selectedId=id;
  var _cur=_tl.querySelector(".entry[data-id='"+id+"']"); if(_cur)_cur.classList.add("sel");
  const e=ALL_ENTRIES.find(x=>x.id===id); if(!e)return;
  const titleEl=document.getElementById("detailTitle");
  const body=document.getElementById("detailBody");
  if(START_TS&&e.ts){const vid=document.getElementById("vid");if(vid){let t=(e.ts-START_TS)/1000-0.5;if(!isFinite(t))t=0;t=Math.max(0,t);if(isFinite(vid.duration)&&vid.duration>0)t=Math.min(t,vid.duration);vid.currentTime=t;}}
  if(e.kind==="note"){titleEl.textContent="Note";body.innerHTML="<div class='fb'><div class='fl'>annotation</div><div style='font-size:14px;color:#fff;line-height:1.5'>"+esc(e.text)+"</div></div><div class='fb'><div class='fl'>timestamp</div><div style='font-size:11px;color:#555;font-family:monospace'>"+new Date(e.ts).toISOString()+"</div></div>";return;}
  if(e.kind==="console"){const cs=CON_STYLE[e.level]||CON_STYLE.log;titleEl.textContent=cs.label+" · "+(e.level||"log").toUpperCase();body.innerHTML="<div class='fb'><div class='fl'>message</div><pre style='color:"+cs.fg+"'>"+esc(e.text||"")+"</pre></div>"+(e.url?"<div class='fb'><div class='fl'>source</div><div style='font-size:11px;color:#7EB8D4;font-family:monospace'>"+esc(e.url)+(e.lineNumber?":"+e.lineNumber:"")+"</div></div>":"")+"<div class='fb'><div class='fl'>timestamp</div><div style='font-size:11px;color:#555;font-family:monospace'>"+new Date(e.ts).toISOString()+"</div></div>";return;}
  if(e.kind==="ws"){const s=WS_STYLE[e.event]||WS_STYLE.received;titleEl.textContent=s.label+" "+e.event.toUpperCase()+(e.idx!==undefined?" #"+e.idx:"");body.innerHTML="<div class='fb'><div class='fl'>url</div><div style='font-size:11px;color:#7EB8D4;font-family:monospace;word-break:break-all'>"+esc(e.url)+"</div></div><div style='display:flex;gap:6px;margin-bottom:12px;align-items:center'><span class='badge' style='background:"+s.bg+";color:"+s.fg+"'>"+s.label+"</span><span class='badge' style='background:#1a1a1a;color:#555'>"+e.event.toUpperCase()+"</span>"+(e.idx!==undefined?"<span style='font-size:10px;color:#444'>msg #"+e.idx+"</span>":"")+"<span style='font-size:10px;color:#444'>"+new Date(e.ts).toISOString()+"</span></div><div class='fb'><div class='fl' style='display:flex;align-items:center;gap:8px'>payload<button id='wsB64Btn' style='font-size:9px;font-weight:600;color:#9bdcc4;background:#0A1F14;border:1px solid #1D5C42;border-radius:3px;padding:1px 6px;cursor:pointer'>Decode base64</button></div><pre id='wsPayload'>"+esc(fmt(e.payload))+"</pre></div>"+(e.note?"<div class='fb'><div class='fl'>note</div><div style='font-size:12px;color:#aaa'>"+esc(e.note)+"</div></div>":"");wireWsB64(e.payload);return;}
  const[bg,fg]=METHOD_COLORS[e.method]||["#1a1a1a","#888"];
  titleEl.textContent=e.method+" "+e.status+" · "+e.ms+"ms";
  body.innerHTML="<div class='fb'><div class='fl'>url</div><div style='font-size:11px;color:#7EB8D4;font-family:monospace;word-break:break-all;line-height:1.5'>"+esc(e.url)+"</div></div>"+"<div style='display:flex;gap:6px;margin-bottom:12px;flex-wrap:wrap;align-items:center'><span class='badge' style='background:"+bg+";color:"+fg+"'>"+e.method+"</span><span class='badge' style='background:"+(e.status>=400?"#2A0A0A":"#0A1F14")+";color:"+(e.status>=400?"#F09595":"#5DCAA5")+"'>"+e.status+"</span><span style='font-size:10px;color:#444'>"+new Date(e.ts).toISOString()+"</span></div>"+(e.reqBody!=null?"<div class='fb'><div class='fl'>request body</div><pre>"+esc(fmt(e.reqBody))+"</pre></div>":"")+"<div class='fb'><div class='fl'>response body</div><pre>"+esc(fmt(e.resBody))+"</pre></div>"+(e.note?"<div class='fb'><div class='fl'>note</div><div style='font-size:12px;color:#aaa'>"+esc(e.note)+"</div></div>":"");
}

/* ── Network tab ─────────────────────────────────────────────── */
let netFilter    = "all";
let netSort      = { col:"ts", dir:"asc" };
let netSelectedId = null;
let netDetailTab  = "response";

function setNetFilter(f, el) {
  netFilter = f;
  document.querySelectorAll(".nftab").forEach(t=>t.classList.remove("active"));
  el.classList.add("active");
  renderNetwork();
}

function sortNet(col) {
  if (netSort.col === col) netSort.dir = netSort.dir==="asc"?"desc":"asc";
  else { netSort.col=col; netSort.dir="asc"; }
  document.querySelectorAll(".net-table th").forEach(th=>{th.classList.remove("sorted-asc","sorted-desc");});
  const th = [...document.querySelectorAll(".net-table th")].find(x => (x.getAttribute("onclick")||"").includes("sortNet('"+col+"')"));
  if(th) th.classList.add("sorted-"+netSort.dir);
  renderNetwork();
}

function renderNetwork() {
  const search = (document.getElementById("netSearch").value||"").toLowerCase();
  let rows = HTTP_ENTRIES.filter(e => {
    if(netFilter==="2xx") return e.status>=200&&e.status<300;
    if(netFilter==="4xx") return e.status>=400&&e.status<500;
    if(netFilter==="5xx") return e.status>=500;
    if(netFilter==="slow") return e.ms>500;
    return true;
  }).filter(e => !search || e.url.toLowerCase().includes(search));

  rows = [...rows].sort((a,b)=>{
    let av=a[netSort.col], bv=b[netSort.col];
    if(netSort.col==="url"){try{av=new URL(a.url).pathname;}catch(_){}try{bv=new URL(b.url).pathname;}catch(_){}}
    if(av<bv)return netSort.dir==="asc"?-1:1;
    if(av>bv)return netSort.dir==="asc"?1:-1;
    return 0;
  });

  document.getElementById("netCount").textContent = rows.length + " requests";

  const tbody = document.getElementById("netBody");
  tbody.innerHTML = rows.map(e=>{
    const isErr = e.status>=400;
    const sc    = STATUS_COLOR(e.status);
    const mfg   = METHOD_FG(e.method);
    const startPct = ((e.ts - e.ms - T_MIN) / T_SPAN * 100).toFixed(1);
    const widthPct  = Math.max((e.ms / T_SPAN * 100), 0.3).toFixed(2);
    const barColor  = isErr ? "#E24B4A" : e.ms>500 ? "#EF9F27" : "#1D9E75";
    let displayUrl="";try{const u=new URL(e.url);displayUrl=u.pathname+(u.search||"");}catch(_){displayUrl=e.url;}
    const sel = e.id===netSelectedId?" sel":"";
    return "<tr class='"+(isErr?"err-row":"")+sel+"' data-id='"+e.id+"' onclick='openNetDetail(\\""+e.id+"\\")'>"+
      "<td style='color:"+sc+";font-weight:600;font-family:monospace'>"+e.status+"</td>"+
      "<td style='color:"+mfg+";font-weight:700;font-family:monospace;font-size:10px'>"+esc(e.method)+"</td>"+
      "<td title='"+esc(e.url)+"' style='color:#aaa'>"+esc(displayUrl)+"</td>"+
      "<td style='color:"+(e.ms>500?"#EF9F27":e.ms>200?"#aaa":"#666")+";font-family:monospace'>"+e.ms+"ms</td>"+
      "<td><div style='position:relative;height:10px;width:100%;background:#1a1a1a;border-radius:2px;overflow:hidden'>"+
        "<div class='timing-bar' style='position:absolute;left:"+startPct+"%;width:"+widthPct+"%;background:"+barColor+";height:100%'></div>"+
      "</div></td>"+
    "</tr>";
  }).join("");
}

function openNetDetail(id) {
  netSelectedId = id;
  renderNetwork();
  const e = ALL_ENTRIES.find(x => x.id===id); if(!e)return;
  if(START_TS&&e.ts){const vid=document.getElementById("vid");if(vid){let t=(e.ts-START_TS)/1000-0.5;if(!isFinite(t))t=0;t=Math.max(0,t);if(isFinite(vid.duration)&&vid.duration>0)t=Math.min(t,vid.duration);vid.currentTime=t;}}
  const tabs   = ["response","request","headers","timing"];
  const detail = document.getElementById("netDetail");
  detail.style.display="flex";
  const tabsEl = document.getElementById("netDetailTabs");
  tabsEl.innerHTML = tabs.map(t=>"<div class='det-tab"+(netDetailTab===t?" active":"")+
    "' onclick='switchNetTab(\\""+t+"\\")'>"+ t.charAt(0).toUpperCase()+t.slice(1)+"</div>").join("");
  renderNetDetailBody(e);
}

function switchNetTab(t) {
  netDetailTab = t;
  document.querySelectorAll(".det-tab").forEach(el=>{el.classList.toggle("active", el.textContent.toLowerCase()===t);});
  const e = ALL_ENTRIES.find(x=>x.id===netSelectedId); if(e) renderNetDetailBody(e);
}

function renderNetDetailBody(e) {
  const body = document.getElementById("netDetailBody");
  if(netDetailTab==="response"){
    body.innerHTML="<pre>"+esc(fmt(e.resBody))+"</pre>";
  } else if(netDetailTab==="request"){
    body.innerHTML=(e.reqBody!=null?"<pre>"+esc(fmt(e.reqBody))+"</pre>":"<div style='color:#555;font-size:11px'>No request body</div>");
  } else if(netDetailTab==="headers"){
    body.innerHTML="<div class='fb'><div class='fl'>URL</div><div style='font-size:11px;color:#7EB8D4;font-family:monospace;word-break:break-all'>"+esc(e.url)+"</div></div>"+
      "<div style='display:grid;grid-template-columns:auto 1fr;gap:4px 16px;font-size:11px;font-family:monospace'>"+
      "<span style='color:#555'>Method</span><span style='color:"+METHOD_FG(e.method)+"'>"+esc(e.method)+"</span>"+
      "<span style='color:#555'>Status</span><span style='color:"+STATUS_COLOR(e.status)+"'>"+e.status+"</span>"+
      "<span style='color:#555'>Duration</span><span style='color:"+(e.ms>500?"#EF9F27":"#888")+"'>"+e.ms+"ms</span>"+
      "<span style='color:#555'>Timestamp</span><span style='color:#888'>"+new Date(e.ts).toISOString()+"</span>"+
      (e.note?"<span style='color:#555'>Note</span><span style='color:#b0a8e8'>"+esc(e.note)+"</span>":"")+
      "</div>";
  } else if(netDetailTab==="timing"){
    const t0 = e.ts - e.ms;
    const barW = Math.max((e.ms/T_SPAN*100),0.5).toFixed(2);
    const barL = ((t0-T_MIN)/T_SPAN*100).toFixed(1);
    const barColor = e.status>=400?"#E24B4A":e.ms>500?"#EF9F27":"#1D9E75";
    body.innerHTML=
      "<div style='margin-bottom:12px'>"+
        "<div style='font-size:10px;color:#444;margin-bottom:6px;text-transform:uppercase;letter-spacing:.5px'>Waterfall</div>"+
        "<div style='position:relative;height:14px;background:#1a1a1a;border-radius:3px;overflow:hidden;margin-bottom:4px'>"+
          "<div style='position:absolute;left:"+barL+"%;width:"+barW+"%;background:"+barColor+";height:100%;border-radius:2px'></div>"+
        "</div>"+
        "<div style='display:flex;justify-content:space-between;font-size:10px;color:#555;font-family:monospace'>"+
          "<span>Start: "+new Date(t0).toISOString().slice(11,23)+"</span>"+
          "<span>End: "+new Date(e.ts).toISOString().slice(11,23)+"</span>"+
        "</div>"+
      "</div>"+
      "<div style='display:grid;grid-template-columns:auto 1fr;gap:4px 16px;font-size:11px;font-family:monospace'>"+
        "<span style='color:#555'>Duration</span><span style='color:"+(e.ms>500?"#EF9F27":"#1D9E75")+"'>"+e.ms+"ms</span>"+
        "<span style='color:#555'>Start offset</span><span style='color:#888'>"+(t0-T_MIN)+"ms from session start</span>"+
      "</div>";
  }
}

/* ── Per-section downloads ───────────────────────────────────── */
function _dlJSON(name, obj){
  const a=document.createElement("a");
  a.href=URL.createObjectURL(new Blob([JSON.stringify(obj,null,2)],{type:"application/json"}));
  a.download=name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(()=>URL.revokeObjectURL(a.href), 1000);
}
function _maybeParse(v){ if(v==null)return null; if(typeof v!=="string")return v; try{return JSON.parse(v);}catch(_){return v;} }
function downloadConsoleLogs(){
  const logs=ALL_ENTRIES.filter(e=>e.kind==="console").map(e=>({
    level:e.level, text:e.text, source:e.source||null, url:e.url||null,
    lineNumber:e.lineNumber||null, ts:e.ts, time:new Date(e.ts).toISOString()
  }));
  if(!logs.length){alert("No console logs in this session.");return;}
  _dlJSON("console-logs-"+Date.now()+".json", logs);
}
function downloadNetworkJSON(){
  const net=ALL_ENTRIES.filter(e=>e.kind==="http").map(e=>({
    method:e.method, url:e.url, status:e.status, durationMs:e.ms,
    ts:e.ts, time:new Date(e.ts).toISOString(),
    requestBody:_maybeParse(e.reqBody), responseBody:_maybeParse(e.resBody),
    note:e.note||undefined
  }));
  if(!net.length){alert("No network requests in this session.");return;}
  _dlJSON("network-"+Date.now()+".json", net);
}
function downloadWebSocket(){
  const ws=ALL_ENTRIES.filter(e=>e.kind==="ws").map(e=>{
    const raw=typeof e.payload==="string"?e.payload:JSON.stringify(e.payload);
    let decoded; try{decoded=b64ToText(raw);}catch(_){decoded=undefined;}
    return { event:e.event, url:e.url, idx:e.idx, ts:e.ts, time:new Date(e.ts).toISOString(),
             payload:e.payload, payloadDecoded:decoded, note:e.note||undefined };
  });
  if(!ws.length){alert("No WebSocket messages in this session.");return;}
  _dlJSON("websocket-"+Date.now()+".json", ws);
}

renderTimeline();
</script>
</body>
</html>`;

  downloadBlob(new Blob([html], { type: "text/html" }), "api-report-" + Date.now() + ".html");
}

async function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload  = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}


/* ── Helpers ─────────────────────────────────────────────────── */
function uid() { return Math.random().toString(36).slice(2) + Date.now(); }

function fmtTime(ts) {
  const d = new Date(ts);
  return d.toTimeString().slice(0,8) + "." + String(d.getMilliseconds()).padStart(3,"0");
}

function esc(s) {
  return String(s||"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/'/g,"&#39;").replace(/"/g,"&quot;");
}

function fmt(v) {
  if (v == null) return "(empty)";
  try { return JSON.stringify(typeof v === "string" ? JSON.parse(v) : v, null, 2); }
  catch (_) { return String(v); }
}

function shortPath(url) {
  try { const u = new URL(url); return u.pathname + (u.search||""); }
  catch (_) { return url.length > 55 ? "…" + url.slice(-52) : url; }
}

// Decode a base64 string to UTF-8 text. Throws if not valid base64.
function b64ToText(str) {
  const s = String(str).trim().replace(/\s+/g, "");
  if (!s || !/^[A-Za-z0-9+/]+={0,2}$/.test(s)) throw new Error("not base64");
  const bin = atob(s);
  const bytes = Uint8Array.from(bin, c => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

// Wires the WS-payload "Decode base64" button to toggle raw ⇄ decoded.
function wireBase64Toggle(payload) {
  const btn = document.getElementById("b64Btn");
  const pre = document.getElementById("wsPayload");
  if (!btn || !pre) return;
  const rawStr = typeof payload === "string" ? payload : JSON.stringify(payload);
  let decoded = false;
  btn.addEventListener("click", () => {
    decoded = !decoded;
    if (decoded) {
      try {
        pre.textContent = fmt(b64ToText(rawStr));   // fmt pretty-prints if decoded text is JSON
        btn.textContent = "Show raw";
      } catch (_) {
        pre.textContent = "(payload is not valid base64)";
        btn.textContent = "Show raw";
      }
    } else {
      pre.textContent = fmt(payload);
      btn.textContent = "Decode base64";
    }
  });
}

function downloadBlob(blob, name) {
  Object.assign(document.createElement("a"), { href:URL.createObjectURL(blob), download:name }).click();
}
