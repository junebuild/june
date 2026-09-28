// OpenTUI loads its musl build only when OPENTUI_LIBC=musl is set; it does not
// detect the libc itself, so on Alpine it dlopens the glibc build, which needs
// ld-linux-x86-64.so.2 and fails. Import this module before @opentui/core.
//
// musl's dynamic loader is /lib/ld-musl-<arch>.so.1; glibc systems do not have
// one. An explicit OPENTUI_LIBC always wins.
import { readdirSync } from "node:fs";

export function detectLibc(): "musl" | "glibc" | undefined {
  if (process.platform !== "linux") return undefined;
  try {
    return readdirSync("/lib").some((f) => f.startsWith("ld-musl-")) ? "musl" : "glibc";
  } catch {
    return "glibc";
  }
}

if (process.env.OPENTUI_LIBC === undefined && detectLibc() === "musl") process.env.OPENTUI_LIBC = "musl";
