// assetCache — a loader for the large files an `unbundled` entry leaves out of a build (#383):
// the PDF engine, a CJK font. Given a directory the app owns (a data volume), it serves each
// file from there and fetches it the first time, so a single binary doesn't carry 40 MiB it
// may never use:
//
//   import { assetCache } from "@junejs/server/assets";
//   const load = assetCache({ dir: "/data/june-assets" });
//   typstWasmRenderer({ load, fonts: [notoSansTC({ load })] });
//
// What it guarantees, so it can sit under a production app:
//   • a file is returned only when its size and SHA-256 match the ref — on disk or downloaded;
//     a stale or corrupt file is replaced, never used (the packages check again regardless);
//   • a download stops at the ref's size, so a wrong URL can't fill the disk;
//   • the file lands by rename from a temp file in the same directory, so a crash leaves no
//     half-written file under the real name;
//   • one download per file per process, however many renders ask at once;
//   • `offline: true` never touches the network: for hosts without egress, the files are
//     copied in beforehand (`dir/<name>`, e.g. dir/typst.wasm), and a missing one is an error
//     that says so.
//
// The request is a fixed URL: no document data leaves. `egress(refs)` says which hosts a
// call would still contact, for a setup check.
//
// AssetRef is the shape @junejs/pdf-typst-wasm defines; it is repeated here, so the server
// depends on no PDF package.

import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

export type AssetRef = { name: string; sha256: string; size: number; urls: string[] };

export type AssetCacheOptions = {
  // Where the files live: one per ref, at dir/<name>.
  dir: string;
  // Never download: serve what is in `dir`, and fail naming the file to copy in when it's
  // missing or doesn't match.
  offline?: boolean;
  // Where to fetch a ref from, in order (default: ref.urls) — a mirror the app controls.
  urls?: (ref: AssetRef) => string[];
  // How to fetch (default: global fetch).
  fetch?: typeof fetch;
};

export interface AssetCache {
  // The file's bytes, from `dir` or downloaded into it; always matching the ref.
  (ref: AssetRef): Promise<Uint8Array>;
  // Whether `dir` already holds a file matching the ref.
  cached(ref: AssetRef): Promise<boolean>;
  // The hosts a call for these refs would contact: [] when all are cached, or when offline.
  egress(refs: AssetRef[]): Promise<{ host: string; sends: "nothing" }[]>;
}

// A temp file older than this is a crashed download; younger ones may be another process's.
const STALE_TEMP_MS = 60 * 60 * 1000;

export function assetCache(opts: AssetCacheOptions): AssetCache {
  const fetcher = opts.fetch ?? fetch;
  const urlsFor = opts.urls ?? ((ref: AssetRef) => ref.urls);
  const inflight = new Map<string, Promise<Uint8Array>>();
  let swept: Promise<void> | undefined;

  const pathOf = (ref: AssetRef) => join(opts.dir, safeName(ref.name));

  async function readMatching(ref: AssetRef): Promise<Uint8Array | undefined> {
    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(await readFile(pathOf(ref)));
    } catch {
      return undefined; // not there
    }
    return bytes.length === ref.size && (await sha256(bytes)) === ref.sha256 ? bytes : undefined;
  }

  async function get(ref: AssetRef): Promise<Uint8Array> {
    const hit = await readMatching(ref);
    if (hit) return hit;
    if (opts.offline) {
      const there = await stat(pathOf(ref)).then(() => true, () => false);
      const state = there ? `in ${opts.dir} but doesn't match` : `not in ${opts.dir}`;
      throw new Error(
        `${ref.name} is ${state}, and this cache is offline: ` +
          `copy the file with sha256 ${ref.sha256} (${ref.size} bytes) to ${pathOf(ref)} — it is at ${ref.urls.join(" or ")}`,
      );
    }
    await (swept ??= sweepTemps(opts.dir));
    const bytes = await download(ref, urlsFor(ref), fetcher);
    await mkdir(opts.dir, { recursive: true });
    const temp = join(opts.dir, `.${safeName(ref.name)}.${crypto.randomUUID()}.tmp`);
    await writeFile(temp, bytes);
    await rename(temp, pathOf(ref)); // atomic on one filesystem: never a half-written file
    return bytes;
  }

  const cache = ((ref: AssetRef) => {
    const running = inflight.get(ref.sha256);
    if (running) return running;
    const p = get(ref).finally(() => inflight.delete(ref.sha256));
    inflight.set(ref.sha256, p);
    return p;
  }) as AssetCache;
  cache.cached = async (ref) => (await readMatching(ref)) !== undefined;
  cache.egress = async (refs) => {
    if (opts.offline) return [];
    const missing = (await Promise.all(refs.map(async (r) => ((await cache.cached(r)) ? [] : urlsFor(r))))).flat();
    return [...new Set(missing.map((u) => new URL(u).host))].map((host) => ({ host, sends: "nothing" as const }));
  };
  return cache;
}

// Each URL in turn; the first whose bytes match wins. The error lists every attempt.
async function download(ref: AssetRef, urls: string[], fetcher: typeof fetch): Promise<Uint8Array> {
  const failures: string[] = [];
  for (const url of urls) {
    try {
      const res = await fetcher(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const declared = Number(res.headers.get("content-length") ?? NaN);
      if (declared > ref.size) throw new Error(`${declared} bytes declared, expected ${ref.size}`);
      const bytes = await readCapped(res, ref.size);
      const digest = await sha256(bytes);
      if (bytes.length !== ref.size || digest !== ref.sha256) throw new Error(`got ${bytes.length} bytes with sha256 ${digest}, expected ${ref.size} with ${ref.sha256}`);
      return bytes;
    } catch (err) {
      failures.push(`${url}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  throw new Error(`${ref.name} could not be fetched (${failures.join("; ") || "no URLs"}). To run without the network, copy the file into the cache directory and pass offline: true`);
}

// The body, cut off one byte past the expected size: enough to know it's wrong, never more.
async function readCapped(res: Response, size: number): Promise<Uint8Array> {
  if (!res.body) return new Uint8Array(await res.arrayBuffer());
  const out = new Uint8Array(size + 1);
  let length = 0;
  const reader = res.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (length + value.length > out.length) {
      out.set(value.subarray(0, out.length - length), length);
      length = out.length;
      await reader.cancel();
      break;
    }
    out.set(value, length);
    length += value.length;
  }
  return out.subarray(0, length);
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// A ref's name becomes a file name: one path segment, nothing that climbs out of `dir`.
function safeName(name: string): string {
  if (!name || name === "." || name === ".." || /[\\/]/.test(name)) throw new Error(`unsafe asset name: ${JSON.stringify(name)}`);
  return name;
}

// Temp files a crashed download left behind; ones still young may belong to another process.
async function sweepTemps(dir: string): Promise<void> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return;
  }
  const now = Date.now();
  await Promise.all(
    names
      .filter((n) => n.startsWith(".") && n.endsWith(".tmp"))
      .map(async (n) => {
        const s = await stat(join(dir, n)).catch(() => undefined);
        if (s && now - s.mtimeMs > STALE_TEMP_MS) await rm(join(dir, n), { force: true });
      }),
  );
}
