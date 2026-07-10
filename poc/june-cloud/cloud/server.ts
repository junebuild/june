// June Cloud — PoC control plane + front-door.
//
// This is the thin layer June Cloud OWNS on top of creekd. creekd deliberately
// does NOT provide it (NON-GOALS: no TLS/hostname routing in the daemon — it
// routes by an `X-Creek-App` header; no multi-host; no dashboard). So June Cloud
// supplies:
//
//   • Control plane  (:8080)  — `POST /v1/deploy`: take an app artifact, spawn it
//     on creekd via the admin API, mint the `{deploy}-{slug}.june.app` hostname,
//     and register host → creekd-app-id.
//   • Front-door     (:8787)  — the piece that turns a hostname into creekd's
//     header routing: Host → app-id → set `X-Creek-App` → proxy to creekd
//     dispatch. Fail-closed on unknown host (mirrors multi-tenancy.md).
//
// Everything talks to creekd purely over its admin API + dispatch listener, so
// pointing at a real Linux creekd (Hetzner/starship) instead of a local dev-mode
// one is just three env vars — nothing here assumes co-location.

const CREEKD_ADMIN = process.env.CREEKD_ADMIN ?? "http://127.0.0.1:9080";
const CREEKD_DISPATCH = process.env.CREEKD_DISPATCH ?? "http://127.0.0.1:9000";
const CREEKD_TOKEN = process.env.CREEKD_TOKEN ?? "";
const ZONE = process.env.JUNE_CLOUD_ZONE ?? "june.app";
const CONTROL_PORT = Number(process.env.CONTROL_PORT ?? 8080);
const FRONTDOOR_PORT = Number(process.env.FRONTDOOR_PORT ?? 8787);
const BUN_BIN = process.env.BUN_BIN ?? Bun.which("bun") ?? "bun";

// --- route table (the front-door's source of truth) ------------------------
// host → { appId, port, slug, deployId }. In production this is the system db
// with the three-layer read path from multi-tenancy.md; here it's a Map.
type Route = { appId: string; port: number; slug: string; deployId: string; createdAt: string };
const routes = new Map<string, Route>();

let nextPort = Number(process.env.APP_PORT_BASE ?? 3100);

// --- creekd admin API client (bearer-authed) -------------------------------
async function creekd(path: string, init?: RequestInit): Promise<Response> {
  const headers = new Headers(init?.headers);
  if (CREEKD_TOKEN) headers.set("authorization", `Bearer ${CREEKD_TOKEN}`);
  headers.set("content-type", "application/json");
  return fetch(`${CREEKD_ADMIN}${path}`, { ...init, headers });
}

// creekd app IDs must match ^[a-z0-9][a-z0-9-]{0,62}$ — the same grammar becomes
// the subdomain, so a valid app id IS a valid hostname label.
const adjectives = ["swift", "amber", "brave", "calm", "clever", "lively", "quiet", "sunny"];
const nouns = ["fox", "otter", "heron", "lark", "maple", "cedar", "reef", "delta"];
function mintDeployId(): string {
  const a = adjectives[Math.floor(Math.random() * adjectives.length)];
  const n = nouns[Math.floor(Math.random() * nouns.length)];
  const suffix = Math.floor(Math.random() * 46656).toString(36).padStart(3, "0"); // 3 base36 chars
  return `${a}-${n}-${suffix}`;
}

function slugOk(slug: string): boolean {
  return /^[a-z0-9][a-z0-9-]{0,40}$/.test(slug);
}

// --- deploy: artifact → creekd spawn → hostname ----------------------------
async function deploy(body: {
  slug: string;
  appDir: string;
  entry?: string;
}): Promise<{ url: string; appId: string; deployId: string; host: string; port: number }> {
  const { slug } = body;
  if (!slugOk(slug)) throw new Error(`invalid tenant slug: ${JSON.stringify(slug)}`);

  const entry = body.entry ?? "server.ts";
  const abs = `${body.appDir.replace(/\/$/, "")}/${entry}`;
  if (!(await Bun.file(abs).exists())) throw new Error(`entry not found: ${abs}`);

  const deployId = mintDeployId();
  const appId = `${deployId}-${slug}`; // e.g. swift-fox-a3k-acme
  const host = `${appId}.${ZONE}`;
  const port = nextPort++;

  // Spawn on creekd. Explicit Command + Args mode with an ABSOLUTE bun path and
  // an absolute entry: no dependency on creekd's CWD or PATH (see the deploy
  // PoC notes). creekd injects nothing but what we pass — so PORT + identity go
  // in via env, and it health-probes /health before we route traffic.
  const spawn = {
    id: appId,
    command: BUN_BIN,
    args: [abs],
    port,
    env: [`PORT=${port}`, `JUNE_DEPLOY_ID=${deployId}`, `JUNE_TENANT_SLUG=${slug}`],
    health_check_path: "/health",
  };
  const res = await creekd("/v1/apps", { method: "POST", body: JSON.stringify(spawn) });
  if (!res.ok) {
    throw new Error(`creekd spawn failed (${res.status}): ${await res.text()}`);
  }

  // Register the route BEFORE health so the front-door can reach it while we poll.
  routes.set(host, { appId, port, slug, deployId, createdAt: new Date().toISOString() });

  await waitHealthy(appId);
  return { url: `http://${host}`, appId, deployId, host, port };
}

// Poll creekd dispatch (via X-Creek-App) until the app answers its health path.
async function waitHealthy(appId: string, timeoutMs = 15000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${CREEKD_DISPATCH}/health`, { headers: { "x-creek-app": appId } });
      if (r.ok) return;
    } catch {
      /* dispatch not ready / app booting */
    }
    await Bun.sleep(200);
  }
  throw new Error(`app ${appId} did not become healthy within ${timeoutMs}ms`);
}

// --- control plane (:8080) -------------------------------------------------
Bun.serve({
  port: CONTROL_PORT,
  async fetch(req) {
    const url = new URL(req.url);
    if (req.method === "POST" && url.pathname === "/v1/deploy") {
      try {
        const out = await deploy(await req.json());
        console.log(`[control] deployed ${out.appId} → ${out.url}`);
        return Response.json(out, { status: 201 });
      } catch (err) {
        console.error(`[control] deploy failed: ${(err as Error).message}`);
        return Response.json({ error: (err as Error).message }, { status: 400 });
      }
    }
    if (req.method === "GET" && url.pathname === "/v1/deployments") {
      return Response.json([...routes.entries()].map(([host, r]) => ({ host, ...r })));
    }
    return new Response("june cloud control plane", { status: 404 });
  },
});
console.log(`[control] listening on :${CONTROL_PORT}  (POST /v1/deploy)`);

// --- front-door (:8787) ----------------------------------------------------
// The bridge creekd leaves to "one layer up": hostname → header routing.
Bun.serve({
  port: FRONTDOOR_PORT,
  async fetch(req) {
    const url = new URL(req.url);
    // Real deploys resolve the host from TLS SNI / a trusted proxy header. Here
    // the Host header carries `{appId}.june.app` (the run script sends it, or a
    // wildcard DNS + cert would in production).
    const host = (req.headers.get("host") ?? "").split(":")[0].toLowerCase();
    const route = routes.get(host);
    if (!route) {
      // Fail-closed: unknown host never falls back to a default tenant.
      return new Response(`unknown host: ${host}\n`, { status: 404 });
    }

    // Hand off to creekd dispatch by setting the header it routes on. creekd
    // owns process supervision + which port is live (blue-green); the front-door
    // only knows the app *id*, never the moving port — that's the clean seam.
    const target = `${CREEKD_DISPATCH}${url.pathname}${url.search}`;
    const headers = new Headers(req.headers);
    headers.set("x-creek-app", route.appId);
    const proxied = await fetch(target, {
      method: req.method,
      headers,
      body: req.method === "GET" || req.method === "HEAD" ? undefined : await req.arrayBuffer(),
      redirect: "manual",
    });
    return new Response(proxied.body, { status: proxied.status, headers: proxied.headers });
  },
});
console.log(`[front-door] listening on :${FRONTDOOR_PORT}  (Host → X-Creek-App → creekd dispatch)`);
console.log(`[front-door] zone: *.${ZONE}  creekd: ${CREEKD_ADMIN} / ${CREEKD_DISPATCH}`);
