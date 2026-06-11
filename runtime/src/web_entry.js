// Installs the Web globals React needs, on deno_core 0.403 / deno_web 0.281.
//
// On this version deno_web's Web-API modules are `lazy_loaded_js` IIFEs: each
// reads the global `__bootstrap` and RETURNS its exports (it does not assign to
// globalThis). They are pulled synchronously with `Deno.core.loadExtScript()`
// (idempotent + self-resolving: e.g. 00_url.js itself loadExtScripts webidl), so
// this is a plain classic script -- no static `ext:` imports (those modules are
// no longer statically importable), no top-level await, no event-loop pumping.
// apploader runs it via execute_script before loading the app graph.
//
// ASCII only: keep this file 7-bit clean (no em-dashes/smart quotes).

const loadWeb = (n) => Deno.core.loadExtScript("ext:deno_web/" + n);
const loadFetch = (n) => Deno.core.loadExtScript("ext:deno_fetch/" + n);

// webidl underpins the rest; load it first (modules also pull it themselves).
Deno.core.loadExtScript("ext:deno_webidl/00_webidl.js");

loadWeb("00_infra.js");
const url = loadWeb("00_url.js");
const urlpattern = loadWeb("01_urlpattern.js");
const domException = loadWeb("01_dom_exception.js");
const event = loadWeb("02_event.js");
const sc = loadWeb("02_structured_clone.js");
const timers = loadWeb("02_timers.js");
const abort = loadWeb("03_abort_signal.js");
const base64 = loadWeb("05_base64.js");
const streams = loadWeb("06_streams.js");
const encoding = loadWeb("08_text_encoding.js");
const file = loadWeb("09_file.js");
const messagePort = loadWeb("13_message_port.js");
const compression = loadWeb("14_compression.js");
const perf = loadWeb("15_performance.js");

Object.assign(globalThis, {
  URL: url.URL,
  URLSearchParams: url.URLSearchParams,
  URLPattern: urlpattern.URLPattern,
  Blob: file.Blob,
  File: file.File,
  DOMException: domException.DOMException,
  CloseEvent: event.CloseEvent,
  CustomEvent: event.CustomEvent,
  ErrorEvent: event.ErrorEvent,
  Event: event.Event,
  EventTarget: event.EventTarget,
  MessageEvent: event.MessageEvent,
  ProgressEvent: event.ProgressEvent,
  PromiseRejectionEvent: event.PromiseRejectionEvent,
  reportError: event.reportError,
  structuredClone: sc.structuredClone,
  clearInterval: timers.clearInterval,
  clearTimeout: timers.clearTimeout,
  setInterval: timers.setInterval,
  setTimeout: timers.setTimeout,
  AbortController: abort.AbortController,
  AbortSignal: abort.AbortSignal,
  atob: base64.atob,
  btoa: base64.btoa,
  ByteLengthQueuingStrategy: streams.ByteLengthQueuingStrategy,
  CountQueuingStrategy: streams.CountQueuingStrategy,
  ReadableStream: streams.ReadableStream,
  ReadableStreamDefaultReader: streams.ReadableStreamDefaultReader,
  TransformStream: streams.TransformStream,
  WritableStream: streams.WritableStream,
  TextDecoder: encoding.TextDecoder,
  TextDecoderStream: encoding.TextDecoderStream,
  TextEncoder: encoding.TextEncoder,
  TextEncoderStream: encoding.TextEncoderStream,
  CompressionStream: compression.CompressionStream,
  DecompressionStream: compression.DecompressionStream,
  MessageChannel: messagePort.MessageChannel,
  MessagePort: messagePort.MessagePort,
  Performance: perf.Performance,
  performance: perf.performance,
  PerformanceEntry: perf.PerformanceEntry,
  PerformanceMark: perf.PerformanceMark,
  PerformanceMeasure: perf.PerformanceMeasure,
});

// Real WHATWG fetch + friends from deno_fetch 0.274 (also lazy_loaded_js). This
// is the headline of the upgrade: server components can fetch over the network
// during SSR with the standard API (no hand-rolled shim). op_fetch reads the
// PermissionsContainer the Rust side installs in OpState. 26_fetch.js depends on
// headers/body/request/response, which it loadExtScripts itself; load them here
// too so we can assign the constructors as globals. Real FormData replaces the
// minimal polyfill we used on 0.380.
// 26_fetch.js destructures Deno's OpenTelemetry hooks from `internals.__telemetry`
// / `internals.__telemetryUtil` at eval time (a bare deno_core embed has no
// deno_telemetry, so they are undefined -> destructuring throws). Seed them as
// objects with TRACING_ENABLED=false, so the span code path is skipped entirely
// and the (here-undefined) tracer/util fns are never actually called.
const __internals = __bootstrap.internals;
__internals.__telemetry = __internals.__telemetry || {
  TRACING_ENABLED: false,
  PROPAGATORS: [],
};
__internals.__telemetryUtil = __internals.__telemetryUtil || {};

const headers = loadFetch("20_headers.js");
const formdata = loadFetch("21_formdata.js");
loadFetch("22_body.js");
loadFetch("22_http_client.js");
const request = loadFetch("23_request.js");
const response = loadFetch("23_response.js");
const fetchMod = loadFetch("26_fetch.js");

Object.assign(globalThis, {
  fetch: fetchMod.fetch,
  Headers: headers.Headers,
  Request: request.Request,
  Response: response.Response,
  FormData: formdata.FormData,
});

// Minimal Web Crypto: getRandomValues + randomUUID, backed by the OS CSPRNG via a
// Rust op. nanoid/uuid and similar ID libs need this during SSR. SubtleCrypto is
// still intentionally omitted here (YAGNI for client-component SSR; deno_crypto
// can be added when a real Web Crypto need appears).
const HEX = [];
for (let i = 0; i < 256; i++) HEX.push((i + 256).toString(16).slice(1));
const cryptoImpl = {
  getRandomValues(view) {
    if (view == null || typeof view.byteLength !== "number" || view.buffer == null) {
      throw new TypeError("getRandomValues expects an integer TypedArray");
    }
    const bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
    Deno.core.ops.op_get_random_values(bytes);
    return view;
  },
  randomUUID() {
    const b = new Uint8Array(16);
    Deno.core.ops.op_get_random_values(b);
    b[6] = (b[6] & 0x0f) | 0x40; // version 4
    b[8] = (b[8] & 0x3f) | 0x80; // variant 10
    return (
      HEX[b[0]] + HEX[b[1]] + HEX[b[2]] + HEX[b[3]] + "-" +
      HEX[b[4]] + HEX[b[5]] + "-" + HEX[b[6]] + HEX[b[7]] + "-" +
      HEX[b[8]] + HEX[b[9]] + "-" +
      HEX[b[10]] + HEX[b[11]] + HEX[b[12]] + HEX[b[13]] + HEX[b[14]] + HEX[b[15]]
    );
  },
};
globalThis.crypto = cryptoImpl;

// Minimal `document` shim so CSS-in-JS libs (emotion, styled-components, MUI) can
// build their style cache and insert <style> tags during SSR. Inserted style tags
// land in __headTags; __JUNE_COLLECT_STYLES__ serializes them for injection into
// the SSR HTML head, __JUNE_RESET_STYLES__ clears between renders.
const __headTags = [];
function __juneEl(tag) {
  const e = {
    _tag: String(tag),
    tagName: String(tag).toUpperCase(),
    nodeType: 1,
    _attrs: {},
    _text: "",
    setAttribute(k, v) {
      this._attrs[k] = String(v);
    },
    getAttribute(k) {
      return k in this._attrs ? this._attrs[k] : null;
    },
    removeAttribute(k) {
      delete this._attrs[k];
    },
    appendChild(n) {
      if (n && typeof n._text === "string") this._text += n._text;
      return n;
    },
    insertBefore(n) {
      return this.appendChild(n);
    },
    removeChild() {},
    addEventListener() {},
    removeEventListener() {},
    get firstChild() {
      return null;
    },
    set textContent(v) {
      this._text = String(v);
    },
    get textContent() {
      return this._text;
    },
    set innerHTML(v) {
      this._text = String(v);
    },
  };
  e.sheet = {
    cssRules: [],
    insertRule(rule, i) {
      e._text += rule;
      return i == null ? 0 : i;
    },
    deleteRule() {},
  };
  return e;
}
if (typeof globalThis.document === "undefined") {
  globalThis.document = {
    nodeType: 9,
    createElement: __juneEl,
    createElementNS(_ns, tag) {
      return __juneEl(tag);
    },
    createTextNode(t) {
      return { nodeType: 3, _text: String(t) };
    },
    querySelector() {
      return null;
    },
    querySelectorAll() {
      return [];
    },
    getElementsByTagName() {
      return [];
    },
    getElementById() {
      return null;
    },
    addEventListener() {},
    removeEventListener() {},
    head: {
      appendChild(el) {
        __headTags.push(el);
        return el;
      },
      insertBefore(el) {
        __headTags.push(el);
        return el;
      },
      removeChild() {},
      querySelectorAll() {
        return [];
      },
    },
    body: {
      appendChild(el) {
        return el;
      },
      removeChild() {},
      addEventListener() {},
      removeEventListener() {},
      style: {},
    },
    documentElement: { style: {} },
  };
}
// emotion (and others) gate their default style cache on `typeof HTMLElement`,
// not `document`; provide a stub so the default cache is created.
if (typeof globalThis.HTMLElement === "undefined") globalThis.HTMLElement = class HTMLElement {};
if (typeof globalThis.Element === "undefined") globalThis.Element = class Element {};
if (typeof globalThis.Node === "undefined") globalThis.Node = class Node {};

// `import "./x.css"` injects here (persistent across renders, deduped by content
// id); collected into the SSR <head> so CSS imports have no FOUC.
const __cssImports = new Map();
globalThis.__JUNE_ADD_CSS__ = function (id, css) {
  __cssImports.set(id, css);
};
globalThis.__JUNE_RESET_STYLES__ = function () {
  __headTags.length = 0; // per-render CSS-in-JS only; CSS imports persist
};
globalThis.__JUNE_COLLECT_STYLES__ = function () {
  let out = "";
  __cssImports.forEach(function (css, id) {
    out += '<style data-june-css="' + id + '">' + css + "</style>";
  });
  for (let i = 0; i < __headTags.length; i++) {
    const t = __headTags[i];
    if (!t || t._tag !== "style" || !t._text) continue;
    let attrs = "";
    for (const k in t._attrs) attrs += " " + k + '="' + t._attrs[k] + '"';
    out += "<style" + attrs + ">" + t._text + "</style>";
  }
  return out;
};

// Browser-only Web APIs: SSR-safe no-ops so deps that touch them during SSR don't
// crash. They get the conventional server behavior (no match / never fires); the
// real APIs exist natively in the browser. Deliberately off-surface: these are
// stubs, not implementations (see docs/npm-support.md).
if (typeof globalThis.matchMedia === "undefined") {
  globalThis.matchMedia = function (q) {
    return {
      matches: false,
      media: String(q),
      onchange: null,
      addEventListener: function () {},
      removeEventListener: function () {},
      addListener: function () {},
      removeListener: function () {},
      dispatchEvent: function () {
        return false;
      },
    };
  };
}
class JuneNoopObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
  takeRecords() {
    return [];
  }
}
if (typeof globalThis.IntersectionObserver === "undefined") globalThis.IntersectionObserver = JuneNoopObserver;
if (typeof globalThis.ResizeObserver === "undefined") globalThis.ResizeObserver = JuneNoopObserver;
if (typeof globalThis.MutationObserver === "undefined") globalThis.MutationObserver = JuneNoopObserver;

// Minimal global `process` for deps that read it as a GLOBAL (process.env.X,
// process.platform) rather than importing it -- node provides it globally, the V8
// isolate does not. NODE_ENV is "development" in dev.
if (typeof globalThis.process === "undefined") {
  globalThis.process = {
    env: { NODE_ENV: "development" },
    platform: "browser",
    browser: true,
    version: "",
    versions: {},
    argv: [],
    nextTick: (fn) => queueMicrotask(fn),
    cwd: () => "/",
  };
}
