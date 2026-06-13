// Dev live-reload — the browser half of the watch story. The supervisor
// (cli watch.ts) restarts the SERVER on save; this module makes the BROWSER
// follow: every dev HTML page gets a tiny script that holds an SSE connection
// to /__june/events. A restart drops the connection; the script reconnects
// and reloads on success. No version tokens, no diffing — the dropped socket
// IS the signal, which is exactly right for a process-restart reload model.
//
// This lives in the startDevServer WRAPPER, never in the pipeline: dev/built
// parity (parity.test.ts compares pipeline outputs byte-for-byte) stays
// untouched, and nothing here can leak into a build.

const EVENTS_PATH = "/__june/events";
const SCRIPT_PATH = "/__june/reload.js";

const RELOAD_JS = `// june dev live-reload: reconnect-after-drop → location.reload()
(() => {
  let dropped = false;
  const connect = () => {
    const es = new EventSource(${JSON.stringify(EVENTS_PATH)});
    es.addEventListener("open", () => {
      if (dropped) location.reload();
      dropped = false;
    });
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

function devEvents(): Response {
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      // One greeting so the browser fires `open`, then a comment heartbeat:
      // a silent stream gets culled by idle timeouts (hosts, proxies), and a
      // culled stream reads as a restart to the client — which reloads.
      const enc = new TextEncoder();
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
