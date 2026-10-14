// The asset types and check @junejs/pdf-typst-wasm/unbundled defines (its src/assets.ts),
// repeated here on purpose: the peer range is ^0.2.0, and 0.2.0 has no ./unbundled, so this
// package must not import it — at run time or in its published types. The shapes are the
// same, so a loader written for one serves both.

export type AssetRef = { name: string; sha256: string; size: number; urls: string[] };

export type AssetLoader = (ref: AssetRef) => Promise<Uint8Array | ArrayBuffer>;

// The loader's bytes, checked against the ref's size and SHA-256 before they are used.
export async function loadVerified(ref: AssetRef, load: AssetLoader): Promise<Uint8Array> {
  const got = await load(ref);
  // WebCrypto refuses a view on a SharedArrayBuffer: copy one into a plain buffer first.
  const bytes = got instanceof Uint8Array ? (got.buffer instanceof SharedArrayBuffer ? got.slice() : got) : new Uint8Array(got);
  if (bytes.byteLength !== ref.size) throw new Error(`${ref.name}: the loader returned ${bytes.byteLength} bytes, expected ${ref.size} (sha256 ${ref.sha256})`);
  const digest = await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>);
  const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  if (hex !== ref.sha256) throw new Error(`${ref.name}: the loader returned bytes with sha256 ${hex}, expected ${ref.sha256}`);
  return bytes;
}
