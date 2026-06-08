let isRecording = false;
let startTime = null;
let timerInterval = null;
let entries = [];
let filter = "all";
let selectedId = null;
let mediaRecorder = null;
let recordedChunks = [];
let captureStream = null;

const METHOD_COLORS = {
  GET:    ["#0D1F35", "#378ADD"],
  POST:   ["#0A1F14", "#1D9E75"],
  PUT:    ["#241800", "#EF9F27"],
  DELETE: ["#2A0A0A", "#E24B4A"],
  PATCH:  ["#1C1530", "#7F77DD"],
};

/* ── Wire up static buttons ──────────────────────────────────── */
document.getElementById("btnStart").addEventListener("click", startRecording);
document.getElementById("btnStop").addEventListener("click", stopRecording);
document.getElementById("btnClear").addEventListener("click", clearAll);
document.getElementById("btnExportJSON").addEventListener("click", exportJSON);
document.getElementById("btnExportHTML").addEventListener("click", exportHTML);
document.getElementById("btnAddNote").addEventListener("click", addNote);
document.getElementById("copyBtn").addEventListener("click", copyDetailJSON);

document.getElementById("noteInput").addEventListener("keydown", (e) => {
  if (e.key === "Enter") addNote();
});

document.querySelectorAll(".ftab").forEach((tab) => {
  tab.addEventListener("click", () => setFilter(tab.dataset.filter, tab));
});

/* ── Listen for API events from background ───────────────────── */
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === "API_EVENT" && isRecording) {
    pushEntry({ kind: "api", ...msg.data, id: uid(), note: "" });
  }
});

/* ── Start recording ─────────────────────────────────────────── */
async function startRecording() {
  showError("");
  document.getElementById("btnStart").disabled = true;

  chrome.runtime.sendMessage({ type: "GET_STREAM_ID" }, async (res) => {
    if (!res || !res.ok) {
      showError("Could not get stream ID: " + (res?.error || "Make sure you navigated to the target page before opening the recorder."));
      document.getElementById("btnStart").disabled = false;
      return;
    }

    try {
      captureStream = await navigator.mediaDevices.getUserMedia({
        video: {
          mandatory: {
            chromeMediaSource: "tab",
            chromeMediaSourceId: res.streamId,
            maxWidth: 1920, maxHeight: 1080, maxFrameRate: 30,
          }
        },
        audio: {
          mandatory: {
            chromeMediaSource: "tab",
            chromeMediaSourceId: res.streamId,
          }
        }
      });
    } catch (err) {
      showError("getUserMedia failed: " + err.message);
      document.getElementById("btnStart").disabled = false;
      return;
    }

    recordedChunks = [];
    const mimeType = ["video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm"]
      .find(t => MediaRecorder.isTypeSupported(t)) || "video/webm";

    mediaRecorder = new MediaRecorder(captureStream, { mimeType });
    mediaRecorder.ondataavailable = (e) => { if (e.data.size > 0) recordedChunks.push(e.data); };
    mediaRecorder.onerror = (e) => showError("MediaRecorder error: " + e.error?.message);
    mediaRecorder.start(1000);

    isRecording = true;
    startTime = Date.now();
    timerInterval = setInterval(tickTimer, 1000);
    setRecUI(true);

    chrome.runtime.sendMessage({ type: "RECORDING_STARTED" });
  });
}

/* ── Stop recording ──────────────────────────────────────────── */
function stopRecording() {
  if (!isRecording) return;
  isRecording = false;
  clearInterval(timerInterval);
  setRecUI(false);

  chrome.runtime.sendMessage({ type: "RECORDING_STOPPED" });

  if (mediaRecorder && mediaRecorder.state !== "inactive") {
    mediaRecorder.onstop = async () => {
      const blob = await makeSeekableWebM(recordedChunks);
      downloadBlob(blob, "screen-recording-" + Date.now() + ".webm");
    };
    mediaRecorder.stop();
  }

  if (captureStream) {
    captureStream.getTracks().forEach(t => t.stop());
    captureStream = null;
  }
}

function setRecUI(on) {
  document.getElementById("recDot").className = "rec-dot" + (on ? " on" : "");
  document.getElementById("recLabel").textContent = on ? "recording" : "stopped";
  document.getElementById("recLabel").className = "rec-label" + (on ? " on" : "");
  document.getElementById("btnStart").disabled = on;
  document.getElementById("btnStop").disabled = !on;
}

function tickTimer() {
  const s = Math.round((Date.now() - startTime) / 1000);
  document.getElementById("timer").textContent =
    String(Math.floor(s / 60)).padStart(2, "0") + ":" + String(s % 60).padStart(2, "0");
}

function showError(msg) {
  const el = document.getElementById("errBanner");
  el.textContent = msg;
  el.style.display = msg ? "block" : "none";
}

/* ── Entries ─────────────────────────────────────────────────── */
function pushEntry(e) {
  entries.push(e);
  updateStats();
  renderTimeline();
  autoScroll();
}

function addNote() {
  const v = document.getElementById("noteInput").value.trim();
  if (!v) return;
  pushEntry({ id: uid(), kind: "note", text: v, ts: Date.now() });
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
  entries = []; selectedId = null;
  updateStats(); renderTimeline();
  document.getElementById("detailTitle").textContent = "Select an entry to inspect";
  document.getElementById("detailBody").innerHTML = "<div style='padding:3rem;text-align:center;color:#333;font-size:12px'>Click any entry in the timeline</div>";
  document.getElementById("copyBtn").style.display = "none";
}

function autoScroll() {
  const tl = document.getElementById("timeline");
  tl.scrollTop = tl.scrollHeight;
}

/* ── Stats ───────────────────────────────────────────────────── */
function updateStats() {
  const apis = entries.filter(e => e.kind === "api");
  document.getElementById("sTotal").textContent = apis.length;
  document.getElementById("s2xx").textContent = apis.filter(e => e.status >= 200 && e.status < 300).length;
  document.getElementById("s4xx").textContent = apis.filter(e => e.status >= 400 && e.status < 500).length;
  document.getElementById("s5xx").textContent = apis.filter(e => e.status >= 500).length;
  document.getElementById("sNotes").textContent = entries.filter(e => e.kind === "note").length;
  const ms = apis.map(e => e.ms).filter(Boolean);
  document.getElementById("sAvg").textContent = ms.length
    ? Math.round(ms.reduce((a, b) => a + b, 0) / ms.length) + "ms" : "—";
}

/* ── Timeline ────────────────────────────────────────────────── */
function renderTimeline() {
  const tl = document.getElementById("timeline");
  const vis = entries.filter(e => {
    if (filter === "err") return e.kind === "api" && e.status >= 400;
    if (filter === "note") return e.kind === "note";
    return true;
  });

  if (!vis.length) {
    tl.innerHTML = "<div class='empty-msg'>" + (entries.length === 0 ? "Start recording to capture API calls" : "No entries match filter") + "</div>";
    return;
  }

  tl.innerHTML = vis.map(e => {
    const sel = e.id === selectedId ? " sel" : "";
    if (e.kind === "note") {
      return "<div class='entry note-e" + sel + "' data-id='" + e.id + "'>" +
        "<div class='erow'>" +
        "<span class='badge' style='background:#1C1530;color:#AFA9EC'>NOTE</span>" +
        "<span style='color:#b0a8e8;font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:200px'>" + esc(e.text) + "</span>" +
        "<span class='ets'>" + fmtTime(e.ts) + "</span>" +
        "</div></div>";
    }
    const isErr = e.status >= 400;
    const [bg, fg] = METHOD_COLORS[e.method] || ["#1a1a1a", "#888"];
    const shortUrl = shortPath(e.url);
    return "<div class='entry" + (isErr ? " err" : "") + sel + "' data-id='" + e.id + "'>" +
      "<div class='erow'>" +
      "<span class='badge' style='background:" + bg + ";color:" + fg + "'>" + e.method + "</span>" +
      "<span class='badge' style='background:" + (isErr ? "#2A0A0A" : "#0A1F14") + ";color:" + (isErr ? "#F09595" : "#5DCAA5") + "'>" + e.status + "</span>" +
      "<span style='font-size:10px;color:#444'>" + e.ms + "ms</span>" +
      "<span class='ets'>" + fmtTime(e.ts) + "</span>" +
      "</div>" +
      "<div class='eurl'>" + esc(shortUrl) + "</div>" +
      "</div>";
  }).join("");

  tl.querySelectorAll(".entry").forEach(el => {
    el.addEventListener("click", () => openDetail(el.dataset.id));
  });
}

/* ── Detail ──────────────────────────────────────────────────── */
function openDetail(id) {
  selectedId = id;
  renderTimeline();
  const e = entries.find(x => x.id === id);
  if (!e) return;

  document.getElementById("copyBtn").style.display = "inline-block";
  const titleEl = document.getElementById("detailTitle");
  const body = document.getElementById("detailBody");

  if (e.kind === "note") {
    titleEl.textContent = "Note";
    body.innerHTML =
      "<div class='fb'><div class='fl'>annotation</div>" +
      "<div style='font-size:14px;color:#fff;line-height:1.5'>" + esc(e.text) + "</div></div>" +
      "<div class='fb'><div class='fl'>timestamp</div>" +
      "<div style='font-size:11px;color:#555;font-family:monospace'>" + new Date(e.ts).toISOString() + "</div></div>";
    return;
  }

  titleEl.textContent = e.method + " " + e.status + " · " + e.ms + "ms";

  body.innerHTML =
    "<div class='fb'><div class='fl'>url</div>" +
    "<div style='font-size:11px;color:#7EB8D4;font-family:monospace;word-break:break-all;line-height:1.5'>" + esc(e.url) + "</div></div>" +
    "<div style='display:flex;gap:6px;margin-bottom:14px;flex-wrap:wrap;align-items:center'>" +
    "<span class='badge' style='background:" + (METHOD_COLORS[e.method] || ["#1a1a1a","#888"])[0] + ";color:" + (METHOD_COLORS[e.method] || ["#1a1a1a","#888"])[1] + "'>" + e.method + "</span>" +
    "<span class='badge' style='background:" + (e.status >= 400 ? "#2A0A0A" : "#0A1F14") + ";color:" + (e.status >= 400 ? "#F09595" : "#5DCAA5") + "'>" + e.status + "</span>" +
    "<span style='font-size:10px;color:#444'>" + new Date(e.ts).toISOString() + "</span></div>" +
    (e.reqBody !== null ? "<div class='fb'><div class='fl'>request body</div><pre>" + esc(fmt(e.reqBody)) + "</pre></div>" : "") +
    "<div class='fb'><div class='fl'>response body</div><pre>" + esc(fmt(e.resBody)) + "</pre></div>" +
    "<div class='fb'><div class='fl'>annotation</div>" +
    "<input class='ann-input' id='annInput' value='" + esc(e.note || "") + "' placeholder='Add a note for this call…'></div>";

  document.getElementById("annInput").addEventListener("input", function () {
    const entry = entries.find(x => x.id === id);
    if (entry) entry.note = this.value;
  });
}

function copyDetailJSON() {
  const e = entries.find(x => x.id === selectedId);
  if (e) navigator.clipboard.writeText(JSON.stringify(e, null, 2));
}

/* ── Export ──────────────────────────────────────────────────── */
function exportJSON() {
  const blob = new Blob([JSON.stringify({
    session: { start: startTime ? new Date(startTime).toISOString() : null, exported: new Date().toISOString() },
    entries
  }, null, 2)], { type: "application/json" });
  downloadBlob(blob, "api-session-" + Date.now() + ".json");
}

function exportHTML() {
  const apis = entries.filter(e => e.kind === "api");
  const rows = entries.map(e => {
    if (e.kind === "note") {
      return "<tr style='background:#f0eeff'><td colspan='6' style='padding:6px 10px;color:#534AB7;font-style:italic'>📝 " + esc(e.text) + " <small style='color:#999'>" + fmtTime(e.ts) + "</small></td></tr>";
    }
    const isErr = e.status >= 400;
    return "<tr><td style='font-family:monospace;font-size:11px'>" + fmtTime(e.ts) + "</td>" +
      "<td><b>" + e.method + "</b></td>" +
      "<td style='font-family:monospace;font-size:10px;word-break:break-all;max-width:300px'>" + esc(e.url) + "</td>" +
      "<td style='font-weight:700;color:" + (isErr ? "#A32D2D" : "#3B6D11") + "'>" + e.status + "</td>" +
      "<td>" + e.ms + "ms</td>" +
      "<td style='font-size:11px;color:#666'>" + esc(e.note || "") + "</td></tr>";
  }).join("");

  const html = "<!DOCTYPE html><html lang='en'><head><meta charset='UTF-8'><title>API Test Report</title>" +
    "<style>body{font-family:system-ui,sans-serif;padding:2rem;color:#1a1a1a;max-width:1200px;margin:0 auto}" +
    "h1{font-size:20px;font-weight:700;margin-bottom:4px}.meta{font-size:12px;color:#888;margin-bottom:1.5rem}" +
    ".stats{display:flex;gap:1rem;margin-bottom:1.5rem;flex-wrap:wrap}.stat{background:#f7f7f7;border-radius:8px;padding:10px 18px}" +
    ".stat-n{font-size:22px;font-weight:700}.stat-l{font-size:11px;color:#999}" +
    "table{border-collapse:collapse;width:100%}th,td{border:1px solid #e8e8e8;padding:6px 10px;text-align:left;font-size:12px}" +
    "th{background:#fafafa;font-weight:600}tr:hover td{background:#fafafa}</style></head><body>" +
    "<h1>API Test Session Report</h1>" +
    "<div class='meta'>Generated " + new Date().toLocaleString() + " &nbsp;·&nbsp; " + apis.length + " API calls &nbsp;·&nbsp; " + entries.filter(e => e.kind === "note").length + " annotations</div>" +
    "<div class='stats'>" +
    "<div class='stat'><div class='stat-n'>" + apis.length + "</div><div class='stat-l'>total calls</div></div>" +
    "<div class='stat'><div class='stat-n' style='color:#3B6D11'>" + apis.filter(e => e.status >= 200 && e.status < 300).length + "</div><div class='stat-l'>2xx ok</div></div>" +
    "<div class='stat'><div class='stat-n' style='color:#A32D2D'>" + apis.filter(e => e.status >= 400 && e.status < 500).length + "</div><div class='stat-l'>4xx errors</div></div>" +
    "<div class='stat'><div class='stat-n' style='color:#A32D2D'>" + apis.filter(e => e.status >= 500).length + "</div><div class='stat-l'>5xx errors</div></div>" +
    "</div><table><thead><tr><th>Time</th><th>Method</th><th>URL</th><th>Status</th><th>Duration</th><th>Note</th></tr></thead>" +
    "<tbody>" + rows + "</tbody></table></body></html>";

  downloadBlob(new Blob([html], { type: "text/html" }), "api-report-" + Date.now() + ".html");
}

/* ── Helpers ─────────────────────────────────────────────────── */
function uid() { return Math.random().toString(36).slice(2) + Date.now(); }

function fmtTime(ts) {
  const d = new Date(ts);
  return d.toTimeString().slice(0, 8) + "." + String(d.getMilliseconds()).padStart(3, "0");
}

function esc(s) {
  return String(s || "").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/'/g,"&#39;").replace(/"/g,"&quot;");
}

function fmt(v) {
  try { return JSON.stringify(typeof v === "string" ? JSON.parse(v) : v, null, 2); }
  catch (_) { return String(v || ""); }
}

function shortPath(url) {
  try { const u = new URL(url); return u.pathname + (u.search || ""); }
  catch (_) { return url.length > 55 ? "…" + url.slice(-52) : url; }
}

function downloadBlob(blob, name) {
  const a = Object.assign(document.createElement("a"), { href: URL.createObjectURL(blob), download: name });
  a.click();
}
