/**
 * background.js — Service worker
 * Uses a synchronous in-memory cache kept in sync with storage.session.
 * CDP event handler is synchronous — no async/await in the hot path.
 */

/* ── State — kept in memory AND storage.session ─────────────── */
let _state = { isRecording: false, targetTabId: null, recorderTabId: null };

async function loadState() {
  const s = await chrome.storage.session.get(["isRecording","targetTabId","recorderTabId"]);
  _state = {
    isRecording:  s.isRecording  ?? false,
    targetTabId:  s.targetTabId  ?? null,
    recorderTabId: s.recorderTabId ?? null,
  };
  return _state;
}

async function saveState(patch) {
  Object.assign(_state, patch);
  await chrome.storage.session.set(_state);
}

// Restore in-memory state when service worker wakes up
loadState();

/* ── In-memory request tracking (keyed by requestId) ────────── */
const pending = {};   // requestId -> { method, url, t0, reqBody, status }
const wsSocks = {};   // requestId -> { url, t0, msgIndex }
let recordingStartMs = 0;  // wall-clock when this recording session began
let reattachAttempts = 0;  // capped re-attach retries for the current session

/* ── Asset filter — only skip true static assets, NOT .json ─── */
const SKIP_ASSET = /\.(js|css|svg|png|jpg|jpeg|gif|webp|woff2?|ttf|eot|ico|map)(\?|$)/i;

/* ── Forward to recorder tab ─────────────────────────────────── */
function forward(data) {
  if (_state.recorderTabId) {
    chrome.tabs.sendMessage(_state.recorderTabId, { type: "API_EVENT", data }).catch(() => {});
  }
}

/* ── Attach debugger + enable the CDP domains we listen on ───── */
async function attachAndEnable(tabId) {
  try {
    await chrome.debugger.attach({ tabId }, "1.3");
  } catch (e) {
    // "Another debugger is already attached" means we're still attached — fine,
    // just (re-)enable the domains below. Any other error is fatal for capture.
    if (!/already attached/i.test(e.message || "")) {
      console.error("[BG] attach failed:", e.message);
      return { ok: false, error: e.message };
    }
  }
  try {
    await chrome.debugger.sendCommand({ tabId }, "Network.enable", { maxPostDataSize: 65536 });
    await chrome.debugger.sendCommand({ tabId }, "Runtime.enable", {});
    await chrome.debugger.sendCommand({ tabId }, "Log.enable", {});
    console.log("[BG] debugger attached, Network+Runtime+Log enabled on tab", tabId);
    return { ok: true };
  } catch (e) {
    console.error("[BG] enable domains failed:", e.message);
    return { ok: false, error: e.message };
  }
}

/* ── CDP event handler — synchronous state reads ─────────────── */
chrome.debugger.onEvent.addListener((source, method, params) => {
  if (!_state.isRecording) return;
  if (source.tabId !== _state.targetTabId) return;

  /* HTTP */
  if (method === "Network.requestWillBeSent") {
    const { requestId, request } = params;
    const url = request.url || "";
    if (!url.startsWith("http")) return;
    if (SKIP_ASSET.test(url.split("?")[0])) return;
    pending[requestId] = {
      method: request.method || "GET",
      url,
      t0: Date.now(),
      status: 0,
      reqBody: request.postData
        ? (() => { try { return JSON.parse(request.postData); } catch (_) { return request.postData; } })()
        : null,
    };
    return;
  }

  if (method === "Network.responseReceived") {
    const { requestId, response } = params;
    if (pending[requestId]) pending[requestId].status = response.status;
    return;
  }

  if (method === "Network.loadingFinished") {
    const { requestId } = params;
    const req = pending[requestId];
    if (!req) return;
    delete pending[requestId];
    // Fetch body async — but capture req snapshot now
    const snap = { ...req };
    chrome.debugger.sendCommand(
      { tabId: source.tabId }, "Network.getResponseBody", { requestId }
    ).then(result => {
      let resBody = null;
      if (result?.body) {
        try { resBody = JSON.parse(result.body); } catch (_) { resBody = result.body; }
      }
      forward({ kind:"http", method:snap.method, url:snap.url, status:snap.status,
                reqBody:snap.reqBody, resBody, ms:Date.now()-snap.t0, ts:Date.now() });
    }).catch(() => {
      forward({ kind:"http", method:snap.method, url:snap.url, status:snap.status,
                reqBody:snap.reqBody, resBody:null, ms:Date.now()-snap.t0, ts:Date.now() });
    });
    return;
  }

  if (method === "Network.loadingFailed") {
    const { requestId, errorText } = params;
    const req = pending[requestId];
    if (!req) return;
    delete pending[requestId];
    forward({ kind:"http", method:req.method, url:req.url, status:0,
              reqBody:req.reqBody, resBody:{ _error: errorText },
              ms:Date.now()-req.t0, ts:Date.now() });
    return;
  }

  /* WebSocket */
  if (method === "Network.webSocketCreated") {
    const { requestId, url } = params;
    wsSocks[requestId] = { url, t0: Date.now(), msgIndex: 0 };
    forward({ kind:"ws", event:"connected", url, ts:Date.now(), ms:0, payload:null });
    return;
  }

  if (method === "Network.webSocketClosed") {
    const { requestId } = params;
    const ws = wsSocks[requestId];
    if (!ws) return;
    forward({ kind:"ws", event:"closed", url:ws.url, ts:Date.now(), ms:Date.now()-ws.t0, payload:null });
    delete wsSocks[requestId];
    return;
  }

  if (method === "Network.webSocketFrameSent") {
    const { requestId, response } = params;
    // Lazily register sockets we didn't see created (e.g. opened before
    // recording, or after a debugger re-attach) so we never drop their frames.
    const ws = wsSocks[requestId] || (wsSocks[requestId] = { url: "(socket opened before capture)", t0: Date.now(), msgIndex: 0 });
    ws.msgIndex++;
    let payload = response.payloadData;
    try { payload = JSON.parse(response.payloadData); } catch (_) {}
    forward({ kind:"ws", event:"sent", url:ws.url, ts:Date.now(), ms:0,
              payload, opcode:response.opcode, idx:ws.msgIndex });
    return;
  }

  if (method === "Network.webSocketFrameReceived") {
    const { requestId, response } = params;
    const ws = wsSocks[requestId] || (wsSocks[requestId] = { url: "(socket opened before capture)", t0: Date.now(), msgIndex: 0 });
    ws.msgIndex++;
    let payload = response.payloadData;
    try { payload = JSON.parse(response.payloadData); } catch (_) {}
    forward({ kind:"ws", event:"received", url:ws.url, ts:Date.now(), ms:0,
              payload, opcode:response.opcode, idx:ws.msgIndex });
    return;
  }

  if (method === "Network.webSocketFrameError") {
    const { requestId, errorMessage } = params;
    const ws = wsSocks[requestId];
    if (!ws) return;
    forward({ kind:"ws", event:"error", url:ws.url, ts:Date.now(), ms:0,
              payload:{ _error: errorMessage } });
    return;
  }

  /* Console logs via Runtime.consoleAPICalled */
  if (method === "Runtime.consoleAPICalled") {
    const { type, args, timestamp } = params;
    // Enabling Runtime makes Chrome replay messages logged BEFORE recording
    // began (their CDP timestamp predates recordingStartMs). Drop them so the
    // timeline only holds logs that map onto the screen recording.
    if (recordingStartMs && timestamp && timestamp < recordingStartMs - 1000) return;
    const text = args.map(a => {
      if (a.type === "string") return a.value;
      if (a.type === "object" && a.preview) {
        return a.preview.description || a.description || JSON.stringify(a.preview.properties?.reduce((o,p) => { o[p.name]=p.value; return o; }, {}));
      }
      return a.value !== undefined ? String(a.value) : a.description || a.type;
    }).join(" ");
    // CDP Runtime timestamp is already in ms since epoch — do NOT scale it.
    forward({ kind:"console", level:type, text, ts: Math.round(timestamp) || Date.now() });
    return;
  }

  /* Errors and warnings via Log.entryAdded */
  if (method === "Log.entryAdded") {
    const { entry } = params;
    if (!entry) return;
    // Same buffered-replay guard as consoleAPICalled.
    if (recordingStartMs && entry.timestamp && entry.timestamp < recordingStartMs - 1000) return;
    forward({ kind:"console", level:entry.level, text:entry.text, source:entry.source,
              url:entry.url, lineNumber:entry.lineNumber, ts: Math.round(entry.timestamp) || Date.now() });
    return;
  }
});

chrome.debugger.onDetach.addListener((source, reason) => {
  console.log("[BG] debugger detached from tab", source.tabId, "reason:", reason);
  if (!_state.isRecording || source.tabId !== _state.targetTabId) return;

  // The debugger drops mid-recording for several reasons: a cross-process
  // navigation/renderer swap, or "canceled_by_user" (the debugging banner gets
  // dismissed — sometimes spuriously alongside the tab-capture bar). Since the
  // user explicitly started recording, try to recover by re-attaching. Cap the
  // retries so we never fight a user who genuinely wants debugging off, and so a
  // reload loop can't spin forever. (Real tab closure clears isRecording via
  // tabs.onRemoved, so the guard above stops us there.)
  // DevTools owning the tab can't be recovered from — surface that instead.
  if (reason === "replaced_with_devtools") {
    if (_state.recorderTabId) chrome.tabs.sendMessage(_state.recorderTabId, { type:"ATTACH_ERROR",
      error:"DevTools is open on the target tab. Chrome allows only one debugger per tab — close DevTools, then Stop and Start again." }).catch(() => {});
    return;
  }
  if (reattachAttempts >= 5) {
    if (_state.recorderTabId) chrome.tabs.sendMessage(_state.recorderTabId, { type:"ATTACH_ERROR",
      error:"Capture keeps getting cancelled. Do NOT click “Cancel” on the “…is debugging this browser” bar — it must stay visible while recording." }).catch(() => {});
    return;
  }
  reattachAttempts++;
  setTimeout(() => {
    if (_state.isRecording && source.tabId === _state.targetTabId) attachAndEnable(source.tabId);
  }, 500);
});

/* ── Message handler ─────────────────────────────────────────── */
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {

  if (msg.type === "OPEN_RECORDER") {
    chrome.tabs.query({ active: true, currentWindow: true }, async (tabs) => {
      if (!tabs[0]) { sendResponse({ ok:false, error:"No active tab" }); return; }
      const targetTabId = tabs[0].id;
      const recorderUrl = chrome.runtime.getURL("recorder.html");
      chrome.tabs.create({ url: recorderUrl }, async (tab) => {
        await saveState({ targetTabId, recorderTabId: tab.id, isRecording: false });
        sendResponse({ ok: true });
      });
    });
    return true;
  }

  if (msg.type === "GET_STREAM_ID") {
    const targetTabId = _state.targetTabId;
    if (!targetTabId) { sendResponse({ ok:false, error:"No target tab" }); return; }
    chrome.tabCapture.getMediaStreamId({ targetTabId }, (streamId) => {
      if (chrome.runtime.lastError || !streamId) {
        sendResponse({ ok:false, error: chrome.runtime.lastError?.message || "getMediaStreamId failed" });
      } else {
        sendResponse({ ok:true, streamId });
      }
    });
    return true;
  }

  if (msg.type === "RECORDING_STARTED") {
    const targetTabId = _state.targetTabId;
    recordingStartMs = Date.now();
    reattachAttempts = 0;
    saveState({ isRecording: true }).then(async () => {
      if (!targetTabId) return;
      const res = await attachAndEnable(targetTabId);
      if (!res.ok && _state.recorderTabId) {
        chrome.tabs.sendMessage(_state.recorderTabId, { type:"ATTACH_ERROR", error: res.error }).catch(() => {});
      }
      chrome.tabs.sendMessage(targetTabId, { type:"RECORDING_STARTED" }).catch(() => {});
    });
    return;
  }

  if (msg.type === "RECORDING_STOPPED") {
    const targetTabId = _state.targetTabId;
    saveState({ isRecording:false, targetTabId:null, recorderTabId:null }).then(async () => {
      if (!targetTabId) return;
      try { await chrome.debugger.detach({ tabId: targetTabId }); } catch (_) {}
      chrome.tabs.sendMessage(targetTabId, { type:"RECORDING_STOPPED" }).catch(() => {});
    });
    return;
  }

  if (msg.type === "GET_STATE") {
    sendResponse({ ..._state });
    return true;
  }
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  if (tabId === _state.recorderTabId || tabId === _state.targetTabId) {
    if (tabId === _state.targetTabId) {
      try { await chrome.debugger.detach({ tabId }); } catch (_) {}
    }
    await saveState({ isRecording:false, targetTabId:null, recorderTabId:null });
  }
});
