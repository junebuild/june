// agent-files.ts — files as turn output (docs/rfc-agent-files.md).
//
// A tool that produces a file (a PDF report, a CSV export, a chart) puts the BYTES in a
// FileStore and returns the FileRef — small JSON — as (part of) its result. The split is the
// point: the messages log is the durable session state and is replayed on every rebuild, so
// it must stay small and JSON-only, and the model has no use for a PDF's bytes anyway. The
// engine sees the ref in the tool result and emits file.attached; a channel reads the bytes
// back through the same FileStore to deliver them (Slack upload, a download link, …).
//
// Ids are CONTENT-ADDRESSED (SHA-256 of the bytes). A remote tool runs at-least-once, so a
// crash-replay may render the same document twice: the retry writes the same key, leaving
// neither an orphan nor a second file. Pure (crypto.subtle, no node:*), so it runs on workerd.

import type { JuneBlob } from "./resources";

// The marker that tells a FileRef apart from any other object in a tool result. A distinct
// key (not `type`) so an app's own `{ type: "file" }` data is never mistaken for one.
export type FileRef = {
  $june: "file";
  id: string; // content address: sha256 hex of the bytes
  name: string; // the filename a channel shows ("revenue-2026-w41.pdf")
  mediaType: string; // "application/pdf"
  size: number; // bytes
};

export type FileMeta = { name: string; mediaType: string };

export interface FileStore {
  put(data: Uint8Array, meta: FileMeta): Promise<FileRef>;
  // The bytes for a ref's id, or null when the store doesn't hold them (expired, another
  // deployment's store, a hand-written ref).
  get(id: string): Promise<Uint8Array | null>;
}

export function isFileRef(v: unknown): v is FileRef {
  if (!v || typeof v !== "object") return false;
  const r = v as Record<string, unknown>;
  return r.$june === "file" && typeof r.id === "string" && typeof r.name === "string" && typeof r.mediaType === "string" && typeof r.size === "number";
}

// Every FileRef in a tool result: the result itself, or nested in arrays and plain objects
// (`{ file }`, `{ files: [...] }`, `{ report: { pdf } }`). Depth-capped and cycle-safe — a
// result is arbitrary tool output — and deduped by id, in first-seen order.
const MAX_DEPTH = 4;
export function fileRefsIn(result: unknown): FileRef[] {
  const out: FileRef[] = [];
  const seen = new Set<unknown>();
  const ids = new Set<string>();
  const walk = (v: unknown, depth: number) => {
    if (!v || typeof v !== "object" || seen.has(v)) return;
    seen.add(v);
    if (isFileRef(v)) {
      if (!ids.has(v.id)) { ids.add(v.id); out.push(v); }
      return;
    }
    if (depth >= MAX_DEPTH) return;
    for (const child of Array.isArray(v) ? v : Object.values(v)) walk(child, depth + 1);
  };
  walk(result, 0);
  return out;
}

async function sha256Hex(data: Uint8Array): Promise<string> {
  // Copy into a fresh ArrayBuffer: digest() rejects a view over a SharedArrayBuffer, and a
  // view's buffer may be larger than the view itself.
  const digest = await crypto.subtle.digest("SHA-256", data.slice().buffer as ArrayBuffer);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function refFor(data: Uint8Array, meta: FileMeta): Promise<FileRef> {
  if (!meta.name) throw new Error("FileStore.put: a file needs a name");
  if (!meta.mediaType) throw new Error("FileStore.put: a file needs a mediaType");
  return { $june: "file", id: await sha256Hex(data), name: meta.name, mediaType: meta.mediaType, size: data.byteLength };
}

// Ids are hex digests; anything else is refused before it reaches a blob key, so a
// hand-written ref can't address another key of the blob store ("../secrets").
const ID = /^[0-9a-f]{64}$/;

// A FileStore over the app's blob resource (local directory in dev, R2 on Cloudflare). Files
// live under `prefix` so they can't collide with the app's own blob keys. Only the bytes are
// stored: the name and media type ride the FileRef, which the reader always has. `blob` may
// be a thunk: hosts open resources asynchronously (a Durable Object binds them from env), and
// the store is installed on a session before any tool needs it.
export function blobFileStore(blob: JuneBlob | (() => JuneBlob | Promise<JuneBlob>), opts: { prefix?: string } = {}): FileStore {
  const prefix = opts.prefix ?? "agent-files/";
  const open = typeof blob === "function" ? blob : () => blob;
  return {
    async put(data, meta) {
      const ref = await refFor(data, meta);
      await (await open()).put(`${prefix}${ref.id}`, data);
      return ref;
    },
    async get(id) {
      return ID.test(id) ? (await open()).get(`${prefix}${id}`) : null;
    },
  };
}

// In-process store for tests and the memory runtime. Bounded: past `maxBytes` (default
// 64 MiB) the least recently used files are dropped, so a long-lived process can't grow
// without limit. A file is needed until its channel delivered it; one evicted before that
// is reported by the channel as not attachable. A single file larger than the cap is kept
// alone.
export function memoryFileStore(opts: { maxBytes?: number } = {}): FileStore & { readonly size: number; readonly bytes: number } {
  const maxBytes = opts.maxBytes ?? 64 * 1024 * 1024;
  const files = new Map<string, Uint8Array>(); // insertion order = recency (oldest first)
  let bytes = 0;
  const touch = (id: string, data: Uint8Array) => {
    files.delete(id);
    files.set(id, data);
  };
  return {
    async put(data, meta) {
      const ref = await refFor(data, meta);
      const prior = files.get(ref.id);
      if (prior) touch(ref.id, prior);
      else {
        files.set(ref.id, data.slice());
        bytes += data.byteLength;
        for (const [id, old] of files) {
          if (bytes <= maxBytes || id === ref.id) break;
          files.delete(id);
          bytes -= old.byteLength;
        }
      }
      return ref;
    },
    async get(id) {
      const data = files.get(id);
      if (!data) return null;
      touch(id, data);
      return data.slice();
    },
    get bytes() {
      return bytes;
    },
    get size() {
      return files.size;
    },
  };
}
