# PoC: `june deploy` → june.cloud (creekd) → `{deploy}-{slug}.june.app`

**Status: green** (verified 2026-07-10 on macOS, bun 1.3.14, creekd `0.0.0-dev`
built from `~/Projects/creek/creekd`). Proves the full deploy loop end-to-end
with a single `./run.sh`.

## What it proves

The riskiest, thesis-carrying chain — that a June app can be shipped by one
command onto a creekd-hosted june.cloud and reached at a per-tenant hostname:

```
  june deploy --target creek
        │  POST /v1/deploy {slug, appDir}
        ▼
  June Cloud CONTROL PLANE (:8080)         ← the layer June Cloud owns
        │  creekd admin API  POST /v1/apps  (Bearer auth)
        │  mint host  {deploy}-{slug}.june.app  → register route
        ▼
  creekd (:9080 admin / :9000 dispatch)    ← adopted, unmodified
        │  spawns  bun app/server.ts  (PORT injected, /health probed)
        ▼
  June app process  (listens on PORT, answers /health)

  ── request path ──
  curl Host: {deploy}-{slug}.june.app
        ▼
  June Cloud FRONT-DOOR (:8787)            ← the hostname→header bridge
        │  Host → app-id → set  X-Creek-App  → proxy
        ▼
  creekd dispatch → the app.  Fail-closed on unknown host.
```

Sample successful run:

```
✓ deployed
  http://amber-maple-9wv-acme.june.app
  (creekd app id: amber-maple-9wv-acme, internal port 3100)

curl -H 'Host: amber-maple-9wv-acme.june.app' http://127.0.0.1:8787/health → ok
curl -H 'Host: amber-maple-9wv-acme.june.app' http://127.0.0.1:8787/
  Hello from June Cloud 👋  tenant acme  deploy id amber-maple-9wv
```

## Run it

```bash
# needs: bun, and a creekd binary (build once):
#   (cd ~/Projects/creek/creekd && go build -o bin/creekd ./cmd/creekd)
./run.sh            # tenant "acme"
./run.sh globex     # another tenant
```

Everything is local — no DNS, no TLS, no root. creekd's cgroup/namespace paths
self-skip on macOS; we're proving the **deploy loop**, not isolation. The Host
header stands in for wildcard DNS. Point at a real Linux creekd (Hetzner /
starship) with zero code change:

```bash
CREEKD_BIN=/path/to/creekd \
CREEKD_ADMIN=http://100.x.x.x:9080 CREEKD_DISPATCH=http://100.x.x.x:9000 \
CREEKD_TOKEN=... ./run.sh
```

## Files

| file | role | maps to |
|---|---|---|
| `app/server.ts` | representative June-shaped app (PORT + `/health` + SIGTERM drain) | what `june build --target creek` emits (JuneHost server entry, `docs/host-interface.md`) |
| `cloud/server.ts` | control plane (`POST /v1/deploy` → creekd spawn) + front-door (Host → `X-Creek-App`) | the layer June Cloud owns above creekd |
| `cli/june-deploy.ts` | `june deploy --target creek` stand-in | a new branch in `packages/june/src/deploy.ts` |
| `run.sh` | boots creekd + cloud, deploys, curls the hostname | the demo harness |

## What's real vs stubbed (honest scope)

**Real / exercised:** the creekd admin API (`POST /v1/apps`, Bearer auth,
explicit `command`+`args`, injected `PORT`/env, `health_check_path`); creekd's
header-based dispatch (`X-Creek-App`); creekd process supervision + health
probing; the `{deploy}-{slug}` id that is simultaneously a valid creekd app id
(`^[a-z0-9][a-z0-9-]{0,62}$`) and a hostname label; fail-closed unknown-host.

**Stubbed (deliberately, not thesis-risky):**

| stubbed here | production shape | owner |
|---|---|---|
| Host header instead of DNS/TLS | wildcard `*.june.app` DNS + cert; front-door reads SNI/trusted host | June Cloud front-door (Cloudflare in front) |
| `appDir` copied in place (co-located) | artifact upload → object store (R2) → placed on the creekd host | control plane + `docs/deployment-sizing.md` |
| `--slug` flag, no auth | slug = caller's team from the June Cloud token; billing/quota | control plane (`docs/multi-tenancy.md`) |
| single local creekd | **multi-host fleet: LB + N creekd hosts + placement + region** | **the ONE layer June Cloud must build — creekd's NON-GOAL N1** |
| plain spawn | blue-green `POST /v1/apps/{id}/deploy` on redeploy | already in creekd |
| macOS dev-mode (no isolation) | gVisor (KVM-free) / microVM for untrusted; first-party June apps run bare | `docs/june-cloud-economics.md` isolation tiers |

## Graft point — turning this into the real `june deploy`

`packages/june/src/deploy.ts` already dispatches on `target`
(`workers`/`vercel`/`deno`/`static`). Add `creek`:

```ts
// deploy.ts — union + dispatch
if (target !== "workers" && target !== "vercel" && target !== "deno"
    && target !== "static" && target !== "creek") { /* … */ }
...
if (target === "creek") return deployCreek(appRoot, cfg, options);

// new deployCreek(): june build (server entry) → POST the artifact to the
// June Cloud control plane (cloud/server.ts) → return { url } from the response.
// The URL regex to surface: /https?:\/\/\S+\.june\.app\S*/
```

The control plane (`cloud/server.ts`) is the seam that stays; only the CLI half
moves into `deploy.ts`. Config: `deploy: { adapter: creek({ zone: "june.app" }) }`.

## This is the `CreekdFleetTarget` prototype

In Creek's architecture (`docs/june-cloud-on-creek.md`), this PoC is the working
prototype of the new **`CreekdFleetTarget`** deploy target + the brand layer:
`cloud/server.ts` = the control-plane branch that spawns on creekd + the
`*.june.app` front-door; Creek's existing `CloudflareWfpTarget` (upload worker to a
WfP dispatch namespace) stays as the other target. Hardening = folding this into
Creek's `deployments` module behind a `DeployTarget` interface.

## Why creekd, not a bespoke stack / not microVMs

Design rationale for the substrate choice lives in the strategy docs:
`docs/june-cloud-economics.md` (build-vs-dogfood: adopt creekd, build only the
multi-host layer it omits) and the `june-creek-convergence` memory. Short form:
creekd is the released, VPS-native supervisor June Cloud's flagship tier needs;
microVMs (boxed-class) are the untrusted-code escape hatch, consumed not built.
