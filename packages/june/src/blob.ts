// `blob` resource adapters — the object/file store seam (JuneBlob). The
// zero-config dev default is a local directory; R2 (and S3-shaped backends) are
// the deploy adapters. Same binding model as db/kv: declare `resources.blob` in
// june.config.ts → injected as ctx.blob.

import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { BlobFactory, JuneBlob } from "junecore/resources";

// Keys come from app code (often user input) — reject path traversal / absolute
// paths so a blob key can never escape the store directory.
function safeKey(key: string): string {
  if (key.startsWith("/") || key.split(/[\\/]/).includes("..")) {
    throw new Error(`unsafe blob key: ${key}`);
  }
  return key;
}

function localBlobHandle(dir: string): JuneBlob {
  return {
    async get(key) {
      const file = join(dir, safeKey(key)); // validate BEFORE the try, or the
      try {
        return new Uint8Array(await readFile(file)); // catch would swallow it
      } catch {
        return null;
      }
    },
    async put(key, data) {
      const file = join(dir, safeKey(key));
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, typeof data === "string" ? data : Buffer.from(data));
    },
    async delete(key) {
      await rm(join(dir, safeKey(key)), { force: true });
    },
    async list(prefix = "") {
      const out: string[] = [];
      async function walk(d: string, base: string) {
        let entries;
        try {
          entries = await readdir(d, { withFileTypes: true });
        } catch {
          return;
        }
        for (const e of entries) {
          const rel = base ? `${base}/${e.name}` : e.name;
          if (e.isDirectory()) await walk(join(d, e.name), rel);
          else if (rel.startsWith(prefix)) out.push(rel);
        }
      }
      await walk(dir, "");
      return out.sort();
    },
  };
}

export function localBlob(opts: { dir?: string } = {}): BlobFactory {
  const dir = opts.dir ?? ".june/blob";
  return {
    kind: "local",
    open: async () => {
      await mkdir(dir, { recursive: true });
      return localBlobHandle(dir);
    },
  };
}

// --- R2 (Cloudflare) --------------------------------------------------------

interface R2ObjectBody {
  arrayBuffer(): Promise<ArrayBuffer>;
}
export interface R2Bucket {
  get(key: string): Promise<R2ObjectBody | null>;
  put(key: string, data: ArrayBuffer | Uint8Array | string): Promise<unknown>;
  delete(key: string): Promise<void>;
  list(opts?: { prefix?: string }): Promise<{ objects: { key: string }[] }>;
}

export function r2(bucket: R2Bucket): BlobFactory {
  const handle: JuneBlob = {
    async get(key) {
      const obj = await bucket.get(key);
      return obj ? new Uint8Array(await obj.arrayBuffer()) : null;
    },
    async put(key, data) {
      await bucket.put(key, data);
    },
    async delete(key) {
      await bucket.delete(key);
    },
    async list(prefix) {
      return (await bucket.list({ prefix })).objects.map((o) => o.key);
    },
  };
  return { kind: "r2", open: async () => handle };
}
