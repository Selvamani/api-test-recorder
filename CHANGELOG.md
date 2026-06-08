# Changelog

## [1.0.0] — 2025-06-08

### Initial release

- Screen recording of the active tab via `chrome.tabCapture` with seekable `.webm` output
- Full API capture using Chrome DevTools Protocol — works with Flutter web, React, Angular, and any framework
- Live toast overlays on the target page for each captured call
- Step annotations — timestamped notes added mid-session
- Per-call detail panel — request body, response body, status, duration
- Export as JSON session log or standalone HTML report
- Seekable WebM via bundled `ts-ebml` (duration + cue index injected post-recording)
