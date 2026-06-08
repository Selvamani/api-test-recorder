# Contributing

Thanks for your interest in contributing!

## Getting started

```bash
git clone https://github.com/YOUR_USERNAME/api-test-recorder.git
cd api-test-recorder
```

No build step. Load the folder directly in Chrome:
- `chrome://extensions` → Developer mode → Load unpacked

## Reload after changes

| File changed | What to do |
|---|---|
| `manifest.json`, `background.js` | Click ↺ reload on `chrome://extensions` |
| `content.js`, `injected.js` | Hard reload target page (`Ctrl+Shift+R`) |
| `recorder.html`, `recorder.js` | Close + reopen recorder tab |
| `popup.html`, `popup.js` | Close + reopen popup |

## Debugging

**Background service worker logs:**
`chrome://extensions` → API Test Recorder → *Inspect views: service worker*

**Target page logs:**
DevTools → Console on the target page — look for `[API-REC]` prefixed lines

**Recorder tab logs:**
DevTools → Console on the recorder tab

## Architecture

```
popup.html / popup.js
  └─ tells background to open recorder tab + inject scripts

background.js  (service worker)
  ├─ chrome.debugger → CDP Network events → forwards to recorder tab
  ├─ chrome.scripting.executeScript → injects content.js + injected.js
  └─ chrome.storage.session → persists state across SW restarts

injected.js  (MAIN world, target page)
  └─ patches window.fetch + XMLHttpRequest as fallback

content.js  (ISOLATED world, target page)
  ├─ listens to chrome.runtime messages (RECORDING_STARTED/STOPPED)
  └─ shows REC badge + toast overlays

recorder.html / recorder.js
  ├─ owns MediaRecorder + captureStream
  ├─ receives API_EVENT messages from background
  ├─ timeline UI, detail panel, annotations
  └─ exports JSON / HTML report

fix-webm.js + EBML.js
  └─ post-processes raw WebM chunks into seekable file
```

## Pull request checklist

- [ ] No `onclick=` / `oninput=` inline handlers in HTML (CSP violation)
- [ ] No hardcoded colours — use existing CSS vars or inline style strings
- [ ] Test on a Flutter web app and a React app
- [ ] Update `CHANGELOG.md` with a summary of changes
- [ ] Bump `version` in `manifest.json`
