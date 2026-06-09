# API Test Recorder — Chrome Extension

A Chrome extension that **screen-records your browser tab** and captures every API call with full request/response details — annotated inline in a live timeline. Built to work with **Flutter web**, React, Angular, and any framework.

![Recorder UI](docs/recorder-ui.png)

---

## Features

- 🎥 **Screen recording** of the active tab (seekable `.webm` via ts-ebml)
- 🌐 **Full API capture** using Chrome DevTools Protocol — works with Flutter web, compiled JS, WebAssembly, anything
- 🟢 **Live toast overlays** on the target page showing each call as it fires
- 📝 **Step annotations** — add timestamped notes mid-session to mark test steps
- 🔍 **Per-call detail** — inspect full request body, response body, status, duration
- 🔌 **WebSocket & console capture** — WS frames and page `console` logs land in the same timeline
- 📊 **Export** — JSON session log, or a **self-contained interactive HTML report** (timeline + DevTools-style network panel, with the screen recording embedded inline)
- ⚡ **Zero config** — no proxy, no server, no page changes needed

---

## Installation

### From source (Developer mode)

1. Clone this repo:
   ```bash
   git clone https://github.com/Selvamani/api-test-recorder.git
   cd api-test-recorder
   ```

2. Open Chrome and go to `chrome://extensions`

3. Enable **Developer mode** (toggle in top-right)

4. Click **Load unpacked** → select the cloned folder

5. The extension icon appears in your toolbar

> **Note:** Do not load from a ZIP. Chrome requires an unpacked folder for developer extensions.

---

## Usage

### Basic flow

1. Navigate to your target web app
2. Click the **API Test Recorder** extension icon
3. Click **⏺ Open Recorder** — a recorder panel opens in a new tab
4. In the recorder tab, click **⏺ Start recording**
   - Chrome shows a *"has started debugging this browser"* banner — this is expected
5. Switch back to your target page and interact with the app
6. API calls appear live in the recorder timeline with method, status, duration
7. Add step annotations (e.g. `"clicked login"`) using the note input — hit Enter
8. Click **⏹ Stop** when done
   - The screen recording downloads as a seekable `.webm` file automatically
9. Export **↓ JSON** or **↓ HTML report** from the recorder

### Reading the timeline

| Colour | Meaning |
|--------|---------|
| Green left border | 2xx success |
| Red left border | 4xx / 5xx error |
| Purple left border | Your annotation note |

Click any entry to inspect the full request/response body in the right panel. Add per-call annotations there too.

### Exports

- **JSON** — full session log with all entries, request bodies, response bodies, timestamps
- **HTML report** — a single self-contained `.html` file you can open in any browser, e‑mail, or attach to a ticket. No server or internet needed — everything (including the screen recording) is embedded inline. It opens as an interactive viewer with:
  - **Timeline tab** — filterable entry list (All / HTTP / Err / WS / Log / Notes) beside the embedded recording; clicking an entry **seeks the video** to that moment and shows full request/response detail
  - **Network tab** — a DevTools-style table with status, method, URL, duration and a request **waterfall**, plus URL search, quick filters (Fetch/XHR, 2xx, 4xx, 5xx, Slow >500ms), sortable columns, and per-request Response / Request / Headers / Timing panels
  - **Summary stats** — HTTP / 2xx / 4xx / 5xx / WS / warnings / errors / notes counts at a glance

---

## How it works

```
Target page HTTP call
        │
        ▼
Chrome DevTools Protocol (CDP)          ← works for ALL frameworks incl. Flutter
        │
        ▼
background.js (service worker)
        │  chrome.tabs.sendMessage
        ▼
recorder.html (timeline UI)
        │
        ▼
Live timeline + toast overlay on target page (content.js)
```

Previous approaches (patching `window.fetch` / `XMLHttpRequest.prototype`) fail for Flutter web because the Dart compiler captures native XHR references at compile time. CDP intercepts at the **browser network stack level**, bypassing all JS entirely.

Screen recording uses `chrome.tabCapture.getMediaStreamId()` → `getUserMedia()` in the recorder tab. The raw WebM chunks are post-processed with [ts-ebml](https://github.com/legokichi/ts-ebml) to inject duration metadata so the file is fully seekable.

---

## Project structure

```
api-test-recorder/
├── manifest.json        # Extension manifest (MV3)
├── background.js        # Service worker — CDP network interception, state management
├── content.js           # Isolated world — REC badge + toast overlays on target page
├── injected.js          # Main world — fetch/XHR patch (fallback for non-CDP cases)
├── popup.html           # Extension popup
├── popup.js             # Popup logic
├── recorder.html        # Full recorder UI (opens as a tab)
├── recorder.js          # Recorder logic — MediaRecorder, timeline, export
├── fix-webm.js          # WebM seekability fix using ts-ebml
├── EBML.js              # Bundled ts-ebml (seekable WebM support)
└── icons/
    ├── icon16.png
    ├── icon48.png
    └── icon128.png
```

---

## Permissions

| Permission | Why |
|-----------|-----|
| `tabCapture` | Record the target tab's screen |
| `debugger` | Attach CDP to intercept all network calls |
| `scripting` | Inject overlay scripts into target page |
| `storage` | Persist recording state across service worker restarts |
| `tabs` | Open the recorder tab, send messages between tabs |
| `activeTab` | Access the currently active tab when popup is clicked |
| `host_permissions: <all_urls>` | Allow injection and CDP on any site |

> The `debugger` permission causes Chrome to show an *"is debugging this browser"* infobar on the target tab while recording. This is a Chrome requirement and cannot be suppressed.

---

## Browser compatibility

| Browser | Support |
|---------|---------|
| Chrome 111+ | ✅ Full support |
| Edge (Chromium) 111+ | ✅ Full support |
| Firefox | ❌ Uses different extension APIs |
| Safari | ❌ Not supported |

---

## Known limitations

- CDP `debugger` API cannot be used simultaneously with Chrome DevTools open on the same tab. Close DevTools before starting a recording session.
- Recording does not capture cross-origin iframes' network calls (CDP limitation).
- Very large response bodies (>5MB) may be truncated in the timeline view.
- The `.webm` file contains the recorder tab UI, not just the target page. Use the side-by-side layout for best results.

---

## Contributing

1. Fork the repo
2. Create a feature branch: `git checkout -b feat/my-feature`
3. Commit your changes: `git commit -m 'feat: add my feature'`
4. Push: `git push origin feat/my-feature`
5. Open a Pull Request

---

## License

MIT — see [LICENSE](LICENSE)
