// `june dev` watch supervisor — a restart IS the reload mechanism. The host's
// ESM module cache cannot be invalidated (re-importing an edited file is a
// cached no-op), so the only honest reload is a fresh process: the supervisor
// watches the app root and respawns the server child on change. Push-based
// HMR belongs to the native runtime track; this is the Bun/Node host's story.

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, watch } from "node:fs";
import { join, relative, resolve, sep } from "node:path";

const IGNORED_DIRS = new Set(["node_modules", ".git", "dist", ".june"]);

// Exported for tests. Toolchain-generated app artifacts — `app/_content.*` (`june gen`) and
// `app/_islands.gen.ts` / any top-level `app/*.gen.ts` (rewritten before every bundle) — must be
// ignored, or watching them loops (regen → write event → regen …).
export function ignoredPath(file: string): boolean {
  const parts = file.split(sep);
  if (parts.some((p) => IGNORED_DIRS.has(p))) return true;
  // Stylesheets are hot-swapped by the dev server (CSS HMR), not a restart — so
  // the supervisor must NOT respawn over a .css edit, or the swap degrades to a
  // full reload. A .tsx edit still restarts (its rendered markup changed too).
  if (file.endsWith(".css")) return true;
  return parts.length === 2 && parts[0] === "app" && (/^_content\.[^/]+$/.test(parts[1]!) || parts[1]!.endsWith(".gen.ts"));
}

export function superviseDev(root: string): undefined {
  let child: ChildProcess | undefined;
  let restarting = false;

  const start = () => {
    // Respawn this exact invocation (bin + argv) with the child marker set.
    child = spawn(process.execPath, process.argv.slice(1), {
      stdio: "inherit",
      env: { ...process.env, JUNE_DEV_CHILD: "1" },
    });
    child.on("exit", (code) => {
      if (restarting) return;
      // Died on its own (e.g. a broken june.config.ts). Stay alive: the next
      // save restarts it — exiting here would make the user re-run dev by hand.
      console.error(`[june] dev server exited (${code ?? "?"}) — waiting for changes`);
      child = undefined;
    });
  };

  const restart = async (file: string, contentChanged: boolean) => {
    if (restarting) return; // an edit mid-restart is picked up by the next save
    restarting = true;
    if (contentChanged) {
      // The frozen manifest must be fresh BEFORE the new server boots.
      try {
        const { generateContent } = await import("@junejs/server");
        await generateContent(root);
      } catch (err) {
        console.error("[june] content regen failed:", err);
      }
    }
    if (file.startsWith(`messages${sep}`)) {
      // Recompile messages/*.json → app/_messages.ts before the server reboots.
      try {
        const { generateMessages } = await import("./messages");
        await generateMessages(root);
      } catch (err) {
        console.error("[june] messages regen failed:", err);
      }
    }
    console.log(`[june] ${file} changed — restarting`);
    const c = child;
    if (!c || c.exitCode !== null || c.signalCode !== null) {
      // The child is already dead (crash state) — once("exit") on an exited
      // process never fires, which would park `restarting` forever. Just
      // bring a fresh one up.
      restarting = false;
      start();
      return;
    }
    c.once("exit", () => {
      restarting = false;
      start();
    });
    c.kill();
  };

  // Debounced scheduling shared by the root watcher and any content-source watchers. `content`
  // ORs across coalesced events, so an app edit landing right after a content edit can't cancel
  // the pending regen.
  let pending: { file: string; content: boolean } | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const schedule = (file: string, content: boolean) => {
    pending = { file, content: content || (pending?.content ?? false) };
    clearTimeout(timer);
    timer = setTimeout(() => void restart(pending!.file, pending!.content), 80);
  };
  watch(root, { recursive: true }, (_event, file) => {
    if (!file || ignoredPath(file)) return;
    schedule(file, file.startsWith(`content${sep}`));
  });

  // Extra content sources (config `content.sources`) live OUTSIDE the app root — fs.watch(root)
  // can't see them, so each gets its own watcher; any change there is a content change (regen +
  // restart). Config is loaded tolerantly and async: if it can't load yet (a generated config
  // importing app/_content.ts before the first freeze), sources simply aren't watched this run —
  // the next `june dev` picks them up. A config edit that CHANGES the source list also needs a
  // dev rerun (the supervisor process caches the config module).
  void (async () => {
    try {
      const { loadJuneConfig } = await import("@junejs/server");
      const config = await loadJuneConfig(root);
      for (const s of config.content?.sources ?? []) {
        const dir = resolve(root, s.dir);
        if (!existsSync(dir)) continue; // gen fails loudly on this; nothing to watch here
        watch(dir, { recursive: true }, (_event, file) => {
          if (!file || ignoredPath(file)) return;
          schedule(relative(root, join(dir, file)), true);
        });
      }
    } catch {
      /* config not loadable yet — see above */
    }
  })();

  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, () => {
      child?.kill(sig);
      process.exit(0);
    });
  }

  start();
  return undefined;
}
