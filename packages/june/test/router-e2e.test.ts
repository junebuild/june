// The opt-in client-router acceptance test, end-to-end through the BUILD: with
// `clientRouter: true`, `june build` wraps the page in <div data-june-root> and
// ships a client.js whose islands runtime starts the router. This test executes
// that real shipped bundle against the real worker-rendered documents (fetch is
// wired to the in-memory worker, the way the browser would hit the network) and
// proves the four properties the /tmp spike validated, now inside June:
//
//   1. a same-origin link click is a SOFT swap, not a full reload
//   2. the swapped-in page's island hydrates fresh (its own props)
//   3. an <Island persist> is CARRIED across the navigation (same live node)
//   4. the nav-generation token drops a stale (superseded) response — the race fix
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { juneBuild, buildManifest } from "../src/build";
import { createWorker } from "../src/worker";

const ROOT = fileURLToPath(new URL("./fixtures/router", import.meta.url));
const ORIGIN = "https://e2e.june";

let outDir: string;
let clientJs: string;
let worker: ReturnType<typeof createWorker>;

// The race test makes one path's fetch resolve slowly so a later navigation can
// overtake it. Module-scoped so the fetch stub can read it.
let delayPath: string | null = null;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function bodyInner(html: string): string {
  const inner = html.match(/<body[^>]*>([\s\S]*)<\/body>/)?.[1] ?? "";
  // Strip the <script src=/client.js> loader: happy-dom would try to fetch it on
  // innerHTML, and the test imports the built bundle by hand instead.
  return inner.replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, "");
}

async function renderBody(path: string): Promise<string> {
  return bodyInner(await (await worker.fetch(new Request(ORIGIN + path))).text());
}

// Click the nav link for a path the way a user would (delegated to document).
function clickNav(path: string): void {
  const link = [...document.querySelectorAll("nav a")].find(
    (a) => new URL((a as HTMLAnchorElement).href).pathname === path,
  ) as HTMLAnchorElement | undefined;
  if (!link) throw new Error(`no nav link for ${path}`);
  link.click();
}

// Production React hydrates asynchronously (no act()), so keep clicking until the
// island actually responds — proof it is live, not just SSR'd markup.
async function clickUntilCounts(btn: HTMLButtonElement): Promise<void> {
  const before = btn.textContent;
  for (let i = 0; i < 200; i++) {
    btn.click();
    await sleep(5);
    if (btn.textContent !== before) return;
  }
  throw new Error(`island never became interactive (stuck at "${btn.textContent}")`);
}

async function poll<T>(fn: () => T | null | undefined, label = "condition"): Promise<T> {
  for (let i = 0; i < 200; i++) {
    const v = fn();
    if (v) return v;
    await sleep(5);
  }
  throw new Error(`timed out waiting for ${label}`);
}

const COUNTER = 'june-island[data-june-island="Counter"] button';
const LIVE = 'june-island[data-june-island="Live"]';

beforeAll(async () => {
  outDir = await mkdtemp(join(tmpdir(), "june-router-e2e-"));
  await juneBuild(ROOT, { outDir });
  const juneDir = join(outDir, "assets", "_june");
  const hashed = (await readdir(juneDir)).find((f) => /^client\.[a-f0-9]{8}\.js$/.test(f))!;
  clientJs = join(juneDir, hashed);

  worker = createWorker(await buildManifest(ROOT));

  GlobalRegistrator.register({ url: ORIGIN + "/" });

  // The router fetches the `fragment` projection on navigation — forward the
  // request init (its Accept header) so the worker negotiates a fragment, not a
  // full document.
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const u = new URL(raw, location.href);
    if (delayPath && u.pathname === delayPath) await sleep(40);
    return worker.fetch(new Request(new URL(u.pathname + u.search, ORIGIN), init));
  }) as typeof fetch;
});

afterAll(async () => {
  GlobalRegistrator.unregister();
  await rm(outDir, { recursive: true, force: true });
});

describe("opt-in client router, end to end", () => {
  test("the built clientRouter app soft-navigates, persists, and wins the race", async () => {
    // The build wraps the page in the swap region — the router's activation signal.
    const homeHtml = await renderBody("/");
    expect(homeHtml).toContain("data-june-root");
    expect(homeHtml).toContain("data-june-persist"); // the persistent island marker
    document.body.innerHTML = homeHtml;

    // Execute the shipped bundle: it hydrates the page AND starts the router.
    await import(pathToFileURL(clientJs).href);

    // (1)+(2) Home's island is live.
    const homeBtn = await poll(
      () => document.querySelector(COUNTER) as HTMLButtonElement | null,
      "home counter",
    );
    expect(homeBtn.textContent).toBe("count: 0"); // SSR'd from props
    await clickUntilCounts(homeBtn);

    // Drive the persistent island's state up (and tag its node), so after a
    // navigation we can prove it was CARRIED (same node, state preserved) rather
    // than re-created (which would reset the count to 0).
    const live = document.querySelector(LIVE) as (Element & { __tag?: string }) | null;
    expect(live).toBeTruthy();
    live!.__tag = "carried";
    const liveBtn = document.querySelector(`${LIVE} button`) as HTMLButtonElement;
    await clickUntilCounts(liveBtn); // hydrate + first ping
    liveBtn.click();
    await sleep(5); // → at least "pings: 2"
    const liveCount = liveBtn.textContent;
    expect(liveCount).not.toBe("pings: 0");

    // (1) Soft-navigate Home → About: the heading morphs in, the old one is gone
    // (the [data-june-root] was morphed in place) — no full document reload.
    clickNav("/about");
    await poll(() => document.querySelector('[data-page="about"]'), "about page");
    expect(document.querySelector('[data-page="home"]')).toBeNull();
    expect(location.pathname).toBe("/about"); // history was pushed

    // (2) About's island hydrated fresh from ITS props (initial: 100).
    const aboutBtn = await poll(
      () => {
        const b = document.querySelector(COUNTER) as HTMLButtonElement | null;
        return b && b.textContent === "count: 100" ? b : null;
      },
      "about counter (initial 100)",
    );
    await clickUntilCounts(aboutBtn);

    // (3) The persistent island is the SAME live node, state intact.
    const liveAfter = document.querySelector(LIVE) as (Element & { __tag?: string }) | null;
    expect(liveAfter).toBeTruthy();
    expect(liveAfter!.__tag).toBe("carried"); // moved across the nav, not re-created
    const liveBtnAfter = document.querySelector(`${LIVE} button`) as HTMLButtonElement;
    expect(liveBtnAfter.textContent).toBe(liveCount); // React state survived (no reset to 0)

    // (4) Race: start a SLOW nav to Home, then immediately overtake it with Users.
    // The token must discard the slow Home response when it finally lands.
    delayPath = "/";
    clickNav("/"); // slow (delayed 40ms)
    clickNav("/users"); // fast — supersedes
    await poll(() => document.querySelector('[data-page="users"]'), "users page");
    await sleep(80); // let the stale Home response arrive...
    expect(document.querySelector('[data-page="users"]')).toBeTruthy(); // ...and be dropped
    expect(document.querySelector('[data-page="home"]')).toBeNull();
    expect(location.pathname).toBe("/users");
    delayPath = null;
  });
});
