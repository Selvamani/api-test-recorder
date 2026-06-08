# Architecture

## Message flow

```
┌─────────────────────────────────────────────────────────────┐
│  Target Page (e.g. https://your-app.com)                    │
│                                                              │
│  ┌──────────────┐    postMessage     ┌──────────────────┐   │
│  │ injected.js  │ ─────────────────▶ │   content.js     │   │
│  │ (MAIN world) │                    │ (ISOLATED world) │   │
│  │              │                    │                  │   │
│  │ patches:     │                    │ - REC badge      │   │
│  │ window.fetch │                    │ - toast overlays │   │
│  │ XHR          │                    │                  │   │
│  └──────────────┘                    └────────┬─────────┘   │
│                                               │             │
│  Chrome Network Stack                         │ sendMessage  │
│  (CDP captures ALL requests)                  │             │
└───────────────────────────┬───────────────────┼─────────────┘
                            │ CDP events        │
                            ▼                   ▼
                   ┌─────────────────────────────────┐
                   │      background.js              │
                   │      (service worker)           │
                   │                                 │
                   │  chrome.debugger.onEvent        │
                   │  → Network.requestWillBeSent    │
                   │  → Network.responseReceived     │
                   │  → Network.loadingFinished      │
                   │    (fetches response body)      │
                   │                                 │
                   │  chrome.storage.session         │
                   │  (survives SW sleep cycles)     │
                   └───────────────┬─────────────────┘
                                   │ sendMessage API_EVENT
                                   ▼
                   ┌─────────────────────────────────┐
                   │      recorder.html              │
                   │                                 │
                   │  ┌───────────┐ ┌─────────────┐  │
                   │  │ Timeline  │ │   Detail    │  │
                   │  │           │ │   Panel     │  │
                   │  │ API calls │ │             │  │
                   │  │ + notes   │ │ req/res     │  │
                   │  └───────────┘ │ body        │  │
                   │                └─────────────┘  │
                   │  MediaRecorder (screen capture) │
                   │  fix-webm.js (seekable WebM)    │
                   └─────────────────────────────────┘
```

## Why CDP instead of JS patching

Flutter web compiles Dart to `main.dart.js`. Inside that bundle:

```js
// Dart compiler output (simplified)
var xhr = XMLHttpRequest;  // ← captured at compile time
// ... thousands of lines later ...
var r = new xhr();  // ← our window.XMLHttpRequest replacement never called
```

No JS-level patch applied after page load can intercept this. Chrome DevTools Protocol operates at the **browser engine level**, below JavaScript entirely — the same layer that powers DevTools' own Network tab.

## State persistence

MV3 service workers shut down after ~30 seconds of inactivity. All in-memory state is lost. We use `chrome.storage.session` which:
- Persists for the browser session (survives SW restarts)
- Is cleared when the browser closes
- Is not synced to Chrome account

## WebM seekability

`MediaRecorder` writes chunks without duration or seek index metadata. `ts-ebml` post-processes the EBML container to inject:
- `Duration` element in the Segment Info block
- `Cues` index for random seek access

This happens in-memory in the recorder tab before download.
