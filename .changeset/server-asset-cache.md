---
"@junejs/server": patch
---

New `@junejs/server/assets`: `assetCache({ dir })`, a ready loader for the PDF packages' `unbundled` entries (#383). It keeps the engine and fonts in a directory you own and downloads each one the first time, so a `bun build --compile` binary stays the size of the Bun runtime and renders offline after first use.

```ts
import { assetCache } from "@junejs/server/assets";

const load = assetCache({ dir: "/data/june-assets" });
typstWasmRenderer({ load, fonts: [notoSansTC({ load })] }); // from the packages' /unbundled entries
```

- A file is used only if its size and SHA-256 match the ref, whether it came from disk or the network. A stale or corrupt copy is replaced, and a download stops at the expected size.
- Files are written to a temp file and renamed into place. Each file is downloaded at most once per process.
- `urls: (ref) => [...]` fetches from your own mirror instead.
- `offline: true` never touches the network: copy the files into `dir` first. A missing file fails with its name, hash and where to get it.
- `load.egress(refs)` and `load.cached(ref)` report what a first render would still fetch, for a setup check.
