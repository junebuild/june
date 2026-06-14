// Dev live-reload — the browser half of the watch story. The supervisor
// (cli watch.ts) restarts the SERVER on save; this module makes the BROWSER
// follow: every dev HTML page gets a tiny script that holds an SSE connection
// to /__june/events. A restart drops the connection; the script reconnects,
// and on success it tries a push-HMR MORPH (window.__juneLiveReload, set by the
// islands runtime when clientRouter is on): re-fetch the current page's fragment
// from the fresh server and morph it in place — island state, focus, and scroll
// survive the edit. It falls back to a full reload when there's no morph hook
// (no clientRouter) or the morph can't apply. The dropped socket IS the signal.
//
// This lives in the startDevServer WRAPPER, never in the pipeline: dev/built
// parity (parity.test.ts compares pipeline outputs byte-for-byte) stays
// untouched, and nothing here can leak into a build.

const EVENTS_PATH = "/__june/events";
const SCRIPT_PATH = "/__june/reload.js";

const RELOAD_JS = `// june dev live-reload: reconnect-after-drop → reload; "css" event → hot-swap
(() => {
  let dropped = false;
  const swapCss = () => {
    document.querySelectorAll('link[rel="stylesheet"]').forEach((old) => {
      const u = new URL(old.href);
      if (u.pathname !== "/_june/global.css") return;
      // Clone with a cache-busted href; drop the old one once the new loads so
      // there's no flash of unstyled content. No page reload → island state and
      // scroll survive.
      const next = old.cloneNode();
      u.searchParams.set("t", Date.now());
      next.href = u.pathname + u.search;
      next.addEventListener("load", () => old.remove(), { once: true });
      old.parentNode.insertBefore(next, old.nextSibling);
    });
  };
  const connect = () => {
    const es = new EventSource(${JSON.stringify(EVENTS_PATH)});
    es.addEventListener("open", () => {
      if (dropped) {
        // push-HMR: morph the freshly-restarted page in place (state survives);
        // hard-reload only if there's no morph hook or it can't apply.
        const hot = window.__juneLiveReload;
        (hot ? hot() : Promise.resolve(false)).then(
          (ok) => { if (!ok) location.reload(); },
          () => location.reload(),
        );
      }
      dropped = false;
    });
    es.addEventListener("css", swapCss); // stylesheet edit → swap, no reload
    es.addEventListener("error", () => {
      dropped = true;
      // EventSource auto-retries while the connection is flaky, but goes to
      // CLOSED (and stays there) on hard failures like a refused connection
      // mid-restart — recreate it ourselves in that case.
      if (es.readyState === EventSource.CLOSED) {
        es.close();
        setTimeout(connect, 300);
      }
    });
  };
  connect();
})();
`;

// Live SSE connections, so a CSS edit can be PUSHED to every open browser (a
// code edit still rides the restart-then-reconnect path). The child watches the
// stylesheet (dev.ts) and calls notifyCssChange; the supervisor ignores .css so
// it does NOT restart — that's what keeps this a hot-swap instead of a reload.
const clients = new Set<ReadableStreamDefaultController<Uint8Array>>();
const enc = new TextEncoder();

export function notifyCssChange(): void {
  const msg = enc.encode("event: css\ndata: 1\n\n");
  for (const c of clients) {
    try {
      c.enqueue(msg);
    } catch {
      clients.delete(c);
    }
  }
}

function devEvents(): Response {
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let self: ReadableStreamDefaultController<Uint8Array> | undefined;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      self = controller;
      clients.add(controller);
      // One greeting so the browser fires `open`, then a comment heartbeat:
      // a silent stream gets culled by idle timeouts (hosts, proxies), and a
      // culled stream reads as a restart to the client — which reloads.
      controller.enqueue(enc.encode("retry: 300\n\ndata: connected\n\n"));
      heartbeat = setInterval(() => {
        try {
          controller.enqueue(enc.encode(":hb\n\n"));
        } catch {
          clearInterval(heartbeat);
        }
      }, 20_000);
    },
    cancel() {
      clearInterval(heartbeat);
      if (self) clients.delete(self);
    },
  });
  return new Response(stream, {
    headers: { "content-type": "text/event-stream", "cache-control": "no-store" },
  });
}

// Wrap the app's fetch: answer the two dev endpoints, and inject the reload
// script into every HTML document on its way out.
export function withLiveReload(
  fetchApp: (req: Request) => Promise<Response>,
): (req: Request) => Promise<Response> {
  return async (req) => {
    const { pathname } = new URL(req.url);
    if (pathname === EVENTS_PATH) return devEvents();
    if (pathname === SCRIPT_PATH) {
      return new Response(RELOAD_JS, {
        headers: { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store" },
      });
    }

    const res = await fetchApp(req);
    if (!res.headers.get("content-type")?.includes("text/html") || !res.body) return res;
    // Append the reload script WITHOUT buffering — streaming routes must stay
    // streamed in dev. The trailing <script defer> runs after the document
    // parses regardless of position, so a final chunk is correct and keeps the
    // shell-first flush intact.
    const tag = new TextEncoder().encode(`<script src="${SCRIPT_PATH}" defer></script>`);
    const tagged = res.body.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          controller.enqueue(chunk);
        },
        flush(controller) {
          controller.enqueue(tag);
        },
      }),
    );
    const headers = new Headers(res.headers);
    headers.delete("content-length"); // the body grew; let the host recompute
    return new Response(tagged, { status: res.status, headers });
  };
}
