// Loads OpenTUI's native core without a terminal and prints the whole error if
// it fails — the TUI itself can only show it inside the pseudo-terminal.
//
//   bun harness/probe.ts          # with the spike's libc detection (src/libc.ts)
//   bun harness/probe.ts --raw    # OpenTUI's own resolution, no detection

if (!process.argv.includes("--raw")) await import("../src/libc");
const { resolveRenderLib } = await import("@opentui/core");

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

export {};
