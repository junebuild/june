// @junejs/pdf-font-noto-sans-kr/unbundled — the provider without its font files (#383). The
// default entries embed them (bun.ts as files, workerd.ts as Data modules), so a
// `bun build --compile` binary carries ~9 MiB whether or not it renders Korean. This entry
// never references them: the app passes `load`, called on the first render with each weight's
// ref, and its bytes are checked against the ref's size and sha256 before they are used.
//
//   import { notoSansKR } from "@junejs/pdf-font-noto-sans-kr/unbundled";
//   typstWasmRenderer({ load, fonts: [notoSansKR({ load })] });
//
// Runtime-neutral: no host imports.

import type { FontEgress } from "@junejs/pdf-typst-wasm";
import { loadVerified, type AssetLoader } from "./assets";
import { createNotoSansKR, NOTO_SANS_KR, type NotoSansKROptions } from "./provider";

export { loadVerified, type AssetLoader, type AssetRef } from "./assets";
export { NOTO_SANS_KR, type NotoSansKROptions, type NotoSansKRWeight } from "./provider";

export type UnbundledNotoSansKROptions = NotoSansKROptions & {
  // Gets a weight's file for its ref. Checked against the ref before the font is registered.
  load: AssetLoader;
  // What `load` contacts, for renderer.egress. Default: the refs' URL hosts, sending nothing
  // (the files may be downloaded). [] when the app pre-seeds them and never fetches.
  egress?: FontEgress[];
};

const HOSTS: FontEgress[] = [...new Set(Object.values(NOTO_SANS_KR).flatMap((r) => r.urls.map((u) => new URL(u).host)))].map((host) => ({ host, sends: "nothing" }));

export function notoSansKR(opts: UnbundledNotoSansKROptions) {
  const { load, egress, ...rest } = opts;
  return createNotoSansKR((weight) => loadVerified(NOTO_SANS_KR[weight], load), rest, egress ?? HOSTS);
}
