/**
 * injected.js — Main world script (fallback interceptor)
 *
 * Responsibilities:
 *  - Patches window.fetch and XMLHttpRequest in the page's JS context
 *  - Posts intercepted calls via window.postMessage to content.js
 *
 * Note: This is a FALLBACK for non-CDP cases. Flutter web and most
 * compiled JS frameworks are captured via CDP in background.js instead.
 * Runs in MAIN world so it shares the page's actual window object.
 */

(function () {
  if (window.__apiRecorderMainInjected) return;
  window.__apiRecorderMainInjected = true;

  const TAG = "__API_REC__";
  const seen = new WeakSet();

  function post(data) {
    window.postMessage({ __apiRec: TAG, data }, "*");
  }

  /* ── fetch ───────────────────────────────────────────────────── */
  const _fetch = window.fetch;
  window.fetch = async function (input, init) {
    const t0 = Date.now();
    const method = ((init && init.method) || "GET").toUpperCase();
    const url = typeof input === "string" ? input : (input?.url || String(input));
    let reqBody = null;
    try { reqBody = init?.body ? JSON.parse(init.body) : null; } catch (_) { reqBody = init?.body || null; }
    let res, status = 0, resBody = null;
    try {
      res = await _fetch.apply(this, arguments);
      status = res.status;
      try { resBody = await res.clone().json(); } catch (_) {
        try { resBody = await res.clone().text(); } catch (_2) {}
      }
    } catch (err) { status = 0; resBody = { _networkError: err.message }; }
    post({ method, url, status, reqBody, resBody, ms: Date.now() - t0, ts: Date.now(), via: "fetch" });
    return res;
  };

  /* ── XHR constructor Proxy (catches Flutter's cached reference) ─ */
  const NativeXHR = window.XMLHttpRequest;

  function makeXHRProxy() {
    const xhr = new NativeXHR();

    let _method = "GET", _url = "", _t0 = Date.now(), _reqBody = null;

    function onDone() {
      if (seen.has(xhr)) return;
      seen.add(xhr);
      let resBody = null;
      try { resBody = JSON.parse(xhr.responseText); } catch (_) { resBody = xhr.responseText || null; }
      // Skip non-API asset requests
      const skip = /\.(js|css|svg|png|jpg|jpeg|gif|woff2?|ttf|ico|map)(\?|$)/i;
      if (_url && skip.test(_url)) return;
      post({ method: _method, url: _url, status: xhr.status, reqBody: _reqBody, resBody, ms: Date.now() - _t0, ts: Date.now(), via: "xhr" });
    }

    xhr.addEventListener("loadend", onDone);

    return new Proxy(xhr, {
      get(target, prop) {
        if (prop === "open") {
          return function (m, u, ...rest) {
            _method = (m || "GET").toUpperCase();
            _url = u || "";
            _t0 = Date.now();
            return target.open(m, u, ...rest);
          };
        }
        if (prop === "send") {
          return function (body) {
            try { _reqBody = body ? JSON.parse(body) : null; } catch (_) { _reqBody = body || null; }
            return target.send(body);
          };
        }
        const val = target[prop];
        return typeof val === "function" ? val.bind(target) : val;
      },
      set(target, prop, value) {
        try { target[prop] = value; } catch (_) {}
        return true;
      }
    });
  }

  // Replace constructor — Flutter calls `new XMLHttpRequest()` at boot,
  // but each actual *request* creates a new instance, so this catches them.
  const PatchedXHR = function XMLHttpRequest() { return makeXHRProxy(); };
  Object.setPrototypeOf(PatchedXHR, NativeXHR);
  PatchedXHR.prototype = NativeXHR.prototype;
  try { Object.defineProperties(PatchedXHR, Object.getOwnPropertyDescriptors(NativeXHR)); } catch (_) {}
  window.XMLHttpRequest = PatchedXHR;

  /* ── Also patch prototype for any non-Flutter XHR ────────────── */
  const _open = NativeXHR.prototype.open;
  const _send = NativeXHR.prototype.send;
  const skip  = /\.(js|css|svg|png|jpg|jpeg|gif|woff2?|ttf|ico|map)(\?|$)/i;

  NativeXHR.prototype.open = function (m, u, ...rest) {
    this.__rm = (m || "GET").toUpperCase();
    this.__ru = u || "";
    this.__rt = Date.now();
    return _open.apply(this, [m, u, ...rest]);
  };
  NativeXHR.prototype.send = function (body) {
    let reqBody = null;
    try { reqBody = body ? JSON.parse(body) : null; } catch (_) { reqBody = body || null; }
    this.addEventListener("loadend", () => {
      if (seen.has(this)) return;
      seen.add(this);
      if (this.__ru && skip.test(this.__ru)) return;
      let resBody = null;
      try { resBody = JSON.parse(this.responseText); } catch (_) { resBody = this.responseText || null; }
      post({ method: this.__rm, url: this.__ru, status: this.status, reqBody, resBody, ms: Date.now() - (this.__rt || Date.now()), ts: Date.now(), via: "xhr-proto" });
    });
    return _send.apply(this, arguments);
  };

  console.log("[API-REC] injected — fetch + XHR constructor proxy + XHR proto all patched");
})();
