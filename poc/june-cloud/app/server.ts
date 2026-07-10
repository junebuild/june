// A representative "June-shaped" app for the june.cloud deploy PoC.
//
// In the real integration this file is what `june build --target creek` emits:
// the JuneHost server entry (see docs/host-interface.md) — a long-running
// process that listens on the injected PORT and answers a health probe. Here
// it's a hand-written stand-in so the PoC proves the *deploy loop*, not the
// framework build. The only contract that matters to creekd:
//
//   1. listen on process.env.PORT   (creekd injects it)
//   2. answer 200 on the health path (creekd probes it before routing traffic)
//   3. drain on SIGTERM              (creekd's blue-green swap sends it)
//
// Anything that honors those three runs as a first-class creekd citizen.

const port = Number(process.env.PORT ?? 3000);
const deployId = process.env.JUNE_DEPLOY_ID ?? "local";
const tenant = process.env.JUNE_TENANT_SLUG ?? "dev";
const bootedAt = new Date().toISOString();

const server = Bun.serve({
  port,
  fetch(req) {
    const url = new URL(req.url);

    // creekd health probe — must be cheap and fast.
    if (url.pathname === "/health") {
      return new Response("ok", { status: 200 });
    }

    // Echo enough to prove *which* deployment answered — the whole point of
    // the routing test is that the right tenant/deploy served the request.
    const body = `<!doctype html>
<meta charset="utf-8">
<title>${tenant} · June Cloud PoC</title>
<main style="font:16px/1.6 system-ui;max-width:40rem;margin:4rem auto;padding:0 1rem">
  <h1>Hello from June Cloud 👋</h1>
  <table>
    <tr><td>tenant</td><td><code>${tenant}</code></td></tr>
    <tr><td>deploy id</td><td><code>${deployId}</code></td></tr>
    <tr><td>served by</td><td><code>${req.headers.get("host") ?? "?"}</code></td></tr>
    <tr><td>internal port</td><td><code>${port}</code></td></tr>
    <tr><td>booted at</td><td><code>${bootedAt}</code></td></tr>
    <tr><td>path</td><td><code>${url.pathname}</code></td></tr>
  </table>
  <p>This process is supervised by <b>creekd</b>; the request reached it via the
     June Cloud front-door (<code>Host</code> → <code>X-Creek-App</code> → creekd dispatch).</p>
</main>`;
    return new Response(body, { headers: { "content-type": "text/html; charset=utf-8" } });
  },
});

console.log(`[app] ${tenant}/${deployId} listening on :${server.port}`);

// Graceful drain — creekd sends SIGTERM during a blue-green swap and SIGKILLs
// after the grace window if the process hasn't exited.
for (const sig of ["SIGTERM", "SIGINT"] as const) {
  process.on(sig, () => {
    console.log(`[app] ${sig} — draining`);
    server.stop();
    process.exit(0);
  });
}
