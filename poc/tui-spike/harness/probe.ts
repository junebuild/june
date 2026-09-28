// Loads OpenTUI's native core without a terminal and prints the whole error if
// it fails — the TUI itself can only show it inside the pseudo-terminal.
// Note: OpenTUI picks the musl build only when OPENTUI_LIBC=musl is set; it
// does not detect the libc itself.
import { resolveRenderLib } from "@opentui/core";

const where = `${process.platform}-${process.arch} OPENTUI_LIBC=${process.env.OPENTUI_LIBC ?? "(unset)"}`;
try {
  resolveRenderLib();
  console.log(`native core loaded on ${where}`);
} catch (e) {
  console.error(`native core failed to load on ${where}`);
  for (let err: unknown = e; err; err = (err as { cause?: unknown }).cause) {
    console.error(err instanceof Error ? `${err.name}: ${err.message}` : String(err));
  }
  process.exit(1);
}
