/* Popup — reflects recording state and lets you start/stop without switching
   to the recorder tab. Start/Stop are relayed to the recorder tab, which owns
   the MediaRecorder + capture stream. */

const els = {
  dot:    document.getElementById("dot"),
  status: document.getElementById("status"),
  open:   document.getElementById("btnOpen"),
  start:  document.getElementById("btnStart"),
  stop:   document.getElementById("btnStop"),
  focus:  document.getElementById("btnFocus"),
  note:   document.getElementById("note"),
  err:    document.getElementById("err"),
};

els.open.addEventListener("click", openRecorder);
els.start.addEventListener("click", startRecording);
els.stop.addEventListener("click", stopRecording);
els.focus.addEventListener("click", focusRecorder);

let state = {};

function refresh() {
  chrome.runtime.sendMessage({ type: "GET_STATE" }, (s) => {
    state = s || {};
    render();
  });
}

function show(el, on) { el.classList.toggle("hidden", !on); }

function render() {
  const hasRecorder = !!state.recorderTabId;
  const recording   = !!state.isRecording;

  els.dot.className = "dot" + (recording ? " rec" : "");
  els.status.textContent = recording ? "Recording…"
    : hasRecorder ? "Recorder ready" : "Not started";

  // Open: only when no recorder tab exists yet.
  show(els.open,  !hasRecorder);
  // Start: recorder open but idle.
  show(els.start, hasRecorder && !recording);
  // Stop: while recording.
  show(els.stop,  recording);
  // Focus: whenever a recorder tab exists.
  show(els.focus, hasRecorder);

  els.note.textContent = !hasRecorder
    ? "Navigate to your target page first, then open the recorder. It captures that tab's screen and API calls."
    : recording ? "Leave the “…is debugging this browser” bar visible — closing it stops capture."
    : "Press Start to begin capturing the target tab.";
}

function openRecorder() {
  busy(true);
  chrome.runtime.sendMessage({ type: "OPEN_RECORDER" }, (res) => {
    if (res && res.ok) { setTimeout(() => window.close(), 500); }
    else { showErr(res?.error || "Could not open recorder"); busy(false); }
  });
}

function startRecording() {
  if (!state.recorderTabId) { showErr("Open the recorder first"); return; }
  busy(true);
  // The recorder tab owns the capture stream / MediaRecorder.
  chrome.tabs.sendMessage(state.recorderTabId, { type: "POPUP_START" }, () => void chrome.runtime.lastError);
  setTimeout(() => { refresh(); busy(false); }, 800);
}

function stopRecording() {
  if (!state.recorderTabId) return;
  busy(true);
  chrome.tabs.sendMessage(state.recorderTabId, { type: "POPUP_STOP" }, () => void chrome.runtime.lastError);
  setTimeout(() => { refresh(); busy(false); }, 600);
}

function focusRecorder() {
  if (!state.recorderTabId) return;
  chrome.tabs.update(state.recorderTabId, { active: true }, (tab) => {
    if (tab && tab.windowId != null) chrome.windows.update(tab.windowId, { focused: true });
    window.close();
  });
}

function busy(on) {
  [els.open, els.start, els.stop, els.focus].forEach(b => b.disabled = on);
}
function showErr(msg) { els.err.textContent = msg || ""; }

refresh();
