/**
 * background.js — Service worker
 *
 * Responsibilities:
 *  - Opens the recorder tab when popup requests it
 *  - Attaches Chrome DevTools Protocol (CDP) debugger to target tab
 *  - Listens for CDP Network events and forwards them to recorder tab
 *  - Manages recording state via chrome.storage.session
 *  - Handles tabCapture stream ID generation for screen recording
 */

async function getState() {
  const s = await chrome.storage.session.get(["isRecording","targetTabId","recorderTabId"]);
  return { isRecording: s.isRecording||false, targetTabId: s.targetTabId||null, recorderTabId: s.recorderTabId||null };
}
async function setState(patch) { await chrome.storage.session.set(patch); }

// CDP network interception — works for ALL requests including Flutter's compiled XHR
const pendingRequests = {}; // requestId -> {method, url, t0, reqBody}
const SKIP = /\.(js|css|svg|png|jpg|jpeg|gif|webp|woff2?|ttf|ico|map|html)(\?|$)/i;

async function attachDebugger(tabId) {
  try {
    await chrome.debugger.attach({ tabId }, "1.3");
    await chrome.debugger.sendCommand({ tabId }, "Network.enable", {});
    console.log("[BG] debugger attached to tab", tabId);
    return true;
  } catch (e) {
    console.error("[BG] debugger attach failed:", e.message);
    return false;
  }
}

async function detachDebugger(tabId) {
  try { await chrome.debugger.detach({ tabId }); } catch (_) {}
}

chrome.debugger.onEvent.addListener(async (source, method, params) => {
  const { isRecording, recorderTabId } = await getState();
  if (!isRecording) return;
  if (source.tabId !== (await getState()).targetTabId) return;

  if (method === "Network.requestWillBeSent") {
    const { requestId, request, timestamp } = params;
    const url = request.url;
    if (SKIP.test(url)) return;
    // Only track http/https
    if (!url.startsWith("http")) return;
    pendingRequests[requestId] = {
      method: request.method,
      url,
      t0: Date.now(),
      reqBody: request.postData ? (() => { try { return JSON.parse(request.postData); } catch (_) { return request.postData; } })() : null
    };
  }

  if (method === "Network.responseReceived") {
    const { requestId, response } = params;
    if (!pendingRequests[requestId]) return;
    pendingRequests[requestId].status = response.status;
    pendingRequests[requestId].mimeType = response.mimeType;
  }

  if (method === "Network.loadingFinished") {
    const { requestId } = params;
    const req = pendingRequests[requestId];
    if (!req) return;
    delete pendingRequests[requestId];

    // Get response body via CDP
    let resBody = null;
    try {
      const result = await chrome.debugger.sendCommand(
        { tabId: source.tabId }, "Network.getResponseBody", { requestId }
      );
      if (result && result.body) {
        try { resBody = JSON.parse(result.body); } catch (_) { resBody = result.body; }
      }
    } catch (_) {}

    const data = {
      method: req.method,
      url: req.url,
      status: req.status || 0,
      reqBody: req.reqBody,
      resBody,
      ms: Date.now() - req.t0,
      ts: Date.now(),
      via: "cdp"
    };

    if (recorderTabId) {
      chrome.tabs.sendMessage(recorderTabId, { type: "API_EVENT", data }).catch(() => {});
    }
  }

  if (method === "Network.loadingFailed") {
    const { requestId, errorText } = params;
    const req = pendingRequests[requestId];
    if (!req) return;
    delete pendingRequests[requestId];
    const data = {
      method: req.method, url: req.url, status: 0,
      reqBody: req.reqBody, resBody: { _error: errorText },
      ms: Date.now() - req.t0, ts: Date.now(), via: "cdp"
    };
    if (recorderTabId) {
      chrome.tabs.sendMessage(recorderTabId, { type: "API_EVENT", data }).catch(() => {});
    }
  }
});

chrome.debugger.onDetach.addListener(async (source) => {
  console.log("[BG] debugger detached from", source.tabId);
});

// ── Message handler ─────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  console.log("[BG] msg:", msg.type);

  if (msg.type === "OPEN_RECORDER") {
    chrome.tabs.query({ active: true, currentWindow: true }, async (tabs) => {
      if (!tabs[0]) { sendResponse({ ok: false, error: "No active tab" }); return; }
      const targetTabId = tabs[0].id;
      const recorderUrl = chrome.runtime.getURL("recorder.html");
      chrome.tabs.create({ url: recorderUrl }, async (tab) => {
        await setState({ targetTabId, recorderTabId: tab.id, isRecording: false });
        sendResponse({ ok: true });
      });
    });
    return true;
  }

  if (msg.type === "GET_STREAM_ID") {
    getState().then(({ targetTabId }) => {
      if (!targetTabId) { sendResponse({ ok: false, error: "No target tab" }); return; }
      chrome.tabCapture.getMediaStreamId({ targetTabId }, (streamId) => {
        if (chrome.runtime.lastError || !streamId) {
          sendResponse({ ok: false, error: chrome.runtime.lastError?.message || "getMediaStreamId failed" });
        } else {
          sendResponse({ ok: true, streamId });
        }
      });
    });
    return true;
  }

  if (msg.type === "RECORDING_STARTED") {
    getState().then(async ({ targetTabId }) => {
      await setState({ isRecording: true });
      // Attach CDP debugger to target tab
      if (targetTabId) {
        await attachDebugger(targetTabId);
        chrome.tabs.sendMessage(targetTabId, { type: "RECORDING_STARTED" }).catch(() => {});
      }
    });
  }

  if (msg.type === "RECORDING_STOPPED") {
    getState().then(async ({ targetTabId }) => {
      if (targetTabId) {
        await detachDebugger(targetTabId);
        chrome.tabs.sendMessage(targetTabId, { type: "RECORDING_STOPPED" }).catch(() => {});
      }
      await setState({ isRecording: false, targetTabId: null, recorderTabId: null });
    });
  }

  if (msg.type === "GET_STATE") {
    getState().then(state => sendResponse(state));
    return true;
  }
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  const { recorderTabId, targetTabId } = await getState();
  if (tabId === recorderTabId || tabId === targetTabId) {
    if (tabId === targetTabId) await detachDebugger(tabId).catch(() => {});
    await setState({ isRecording: false, targetTabId: null, recorderTabId: null });
  }
});
