# API Test Recorder — Chrome Extension

A Chrome extension that **screen-records your browser tab** and captures every API call with full request/response details — annotated inline in a live timeline. Built to work with **Flutter web**, React, Angular, and any framework.

![Recorder UI](docs/recorder-ui.png)

---

## Features

- 🎥 **Screen recording** of the active tab — saved as **`.mp4` (H.264)** on Chrome 130+, with automatic fallback to seekable `.webm` (via ts-ebml) on older browsers
- 🌐 **Full API capture** using Chrome DevTools Protocol — works with Flutter web, compiled JS, WebAssembly, anything
- 🟢 **Live toast overlays** on the target page showing each call as it fires
- 📝 **Step annotations** — add timestamped notes mid-session to mark test steps
- 🔍 **Per-call detail** — inspect full request body, response body, status, duration
- 🔌 **WebSocket & console capture** — WS frames and page `console` logs land in the same timeline
- ▶️ **Video-synced playback** — in the HTML report, the timeline and detail panel follow the recording as it plays; click any entry to jump the video to that moment
- 🎛️ **Toolbar popup controls** — start/stop recording and jump to the recorder right from the extension icon
- 📊 **Export** — JSON session log, or a **self-contained interactive HTML report** (timeline + DevTools-style network panel + embedded recording); plus one-click downloads of console logs, network req/res, or WebSocket frames as JSON
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
2. Click the **API Test Recorder** extension icon — the popup shows recording status and **Start / Stop / Open Recorder** controls
3. Click **⏺ Open Recorder** — a recorder panel opens in a new tab
4. Click **⏺ Start recording** (from the popup or the recorder tab)
   - Chrome shows a *"has started debugging this browser"* banner — **leave it up**; dismissing it (Cancel / ✕) stops capture
5. Switch back to your target page and interact with the app
   - 💡 If your app opens a **WebSocket on page load**, reload the page *after* starting the recording so the socket is captured from the start
6. API calls, WS frames and console logs appear live in the recorder timeline
7. Add step annotations (e.g. `"clicked login"`) using the note input — hit Enter
8. Click **⏹ Stop** when done (popup or recorder tab)
   - The screen recording downloads automatically as `.mp4` (or `.webm` on older Chrome)
9. Export **↓ JSON** or **↓ HTML report** from the recorder

### Reading the timeline

| Colour | Meaning |
|--------|---------|
| Green left border | 2xx success |
| Red left border | 4xx / 5xx error |
| Blue left border | WebSocket frame |
| Grey left border | Console log |
| Purple left border | Your annotation note |

Click any entry to inspect the full request/response body in the right panel. Add per-call annotations there too. In the exported report, a green **playing** highlight tracks the current video position during playback.

### Exports

- **JSON** — full session log with all entries, request bodies, response bodies, timestamps
- **HTML report** — a single self-contained `.html` file you can open in any browser, e‑mail, or attach to a ticket. No server or internet needed — everything (including the screen recording) is embedded inline. It opens as an interactive viewer with:
  - **Timeline tab** — filterable entry list (All / HTTP / Err / WS / Log / Notes) beside the embedded recording. Each entry shows its ⏱ offset into the video; clicking one **seeks the video** to that moment and shows full request/response detail.
  - **Video-synced replay** — press play and the timeline highlights, auto-scrolls, and swaps the detail panel to match the current moment; events within the same instant are grouped. Scrubbing the video jumps the highlight too.
  - **Network tab** — a DevTools-style table with status, method, URL, duration and a request **waterfall**, plus URL search, quick filters (Fetch/XHR, 2xx, 4xx, 5xx, Slow >500ms), sortable columns, and per-request Response / Request / Headers / Timing panels
  - **WebSocket payloads** — a **Decode base64** toggle on WS frames (handy for protocols like NATS that base64-encode payloads)
  - **Per-section downloads** — buttons to export **Console logs**, **Network** req/res, or **WebSocket** frames on their own as JSON (WS export includes decoded payloads)
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

Screen recording uses `chrome.tabCapture.getMediaStreamId()` → `getUserMedia()` in the recorder tab. The recorder prefers **MP4 (H.264 + AAC)** where `MediaRecorder` supports it (Chrome 130+) and otherwise falls back to WebM. WebM output is post-processed with [ts-ebml](https://github.com/legokichi/ts-ebml) to inject duration metadata so it is fully seekable; in the HTML report the embedded recording is rehydrated to a Blob URL so seeking stays accurate regardless of format.

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
| Chrome 111+ | ✅ Full support (WebM recording) |
| Chrome 130+ | ✅ Full support + native **MP4** recording |
| Edge (Chromium) 111+ | ✅ Full support |
| Firefox | ❌ Uses different extension APIs |
| Safari | ❌ Not supported |

---

## Known limitations

- CDP `debugger` API cannot be used simultaneously with Chrome DevTools open on the same tab. Close DevTools before starting a recording session. (Dismissing the "is debugging this browser" banner also stops capture — the recorder auto-reattaches a few times, but leave the banner up.)
- WebSockets opened **before** recording starts aren't captured by Chrome — reload the target page after pressing Start so the socket reconnects under capture.
- Recording does not capture cross-origin iframes' network calls (CDP limitation).
- Very large response bodies (>5MB) may be truncated in the timeline view.
- Long sessions are memory-bound: everything is held in memory until Stop, and HTML-with-embedded-video export becomes unreliable past ~15–20 min (the video is base64-embedded). For long captures, prefer the JSON export plus the separately-saved video file.
- The recording contains the recorder tab UI, not just the target page. Use the side-by-side layout for best results.

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
