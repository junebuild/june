// @junejs/pdf-font-noto-sans-sc/unbundled — the provider without its font files (#383). The
// default entries embed them (bun.ts as files, workerd.ts as Data modules), so a
// `bun build --compile` binary carries ~16 MiB whether or not it renders Chinese. This entry
// never references them: the app passes `load`, called on the first render with each weight's
// ref, and its bytes are checked against the ref's size and sha256 before they are used.
//
//   import { notoSansSC } from "@junejs/pdf-font-noto-sans-sc/unbundled";
//   typstWasmRenderer({ load, fonts: [notoSansSC({ load })] });
//
// Runtime-neutral: no host imports.

import type { FontEgress } from "@junejs/pdf-typst-wasm";
import { loadVerified, type AssetLoader } from "./assets";
import { createNotoSansSC, NOTO_SANS_SC, type NotoSansSCOptions } from "./provider";

export { loadVerified, type AssetLoader, type AssetRef } from "./assets";
export { NOTO_SANS_SC, type NotoSansSCOptions, type NotoSansSCWeight } from "./provider";

export type UnbundledNotoSansSCOptions = NotoSansSCOptions & {
  // Gets a weight's file for its ref. Checked against the ref before the font is registered.
  load: AssetLoader;
  // What `load` contacts, for renderer.egress. Default: the refs' URL hosts, sending nothing
  // (the files may be downloaded). [] when the app pre-seeds them and never fetches.
  egress?: FontEgress[];
};

const HOSTS: FontEgress[] = [...new Set(Object.values(NOTO_SANS_SC).flatMap((r) => r.urls.map((u) => new URL(u).host)))].map((host) => ({ host, sends: "nothing" }));

export function notoSansSC(opts: UnbundledNotoSansSCOptions) {
  const { load, egress, ...rest } = opts;
  return createNotoSansSC((weight) => loadVerified(NOTO_SANS_SC[weight], load), rest, egress ?? HOSTS);
}
