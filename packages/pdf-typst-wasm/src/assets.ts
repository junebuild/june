// Large files a package needs but doesn't embed (#383). The `unbundled` entries never reference
// their files, so `bun build --compile` leaves ~41 MB of engine and fonts out of a binary that
// may never render a PDF; the app supplies a loader instead (a cache on a volume, a download,
// a file it shipped next to the binary).
//
// The package, not the loader, is what's trusted: every ref pins a size and a sha256, and
// loadVerified checks the loader's bytes against them before they are used, so a naive loader
// (one fetch, no checks) is as safe as a careful one. The URLs are where the file can be
// fetched; any of them may be down, and none of them needs to be trusted.
//
// Nothing here depends on PDF types: another package with a large optional file can use it.

export type AssetRef = {
  // The file's name, for errors and for a cache directory: "typst.wasm".
  name: string;
  // Hex SHA-256 of the file's bytes: the only thing trusted.
  sha256: string;
  // Bytes. A loader may use it to cut a download off.
  size: number;
  // Where the file can be fetched, in order of preference.
  urls: string[];
};

// The app's way to get a file's bytes: from a cache, a download, a pre-seeded directory.
export type AssetLoader = (ref: AssetRef) => Promise<Uint8Array | ArrayBuffer>;

// The loader's bytes, after checking them against the ref. Throws an error naming the file and
// both digests when they don't match: a wrong engine or font is never used.
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
