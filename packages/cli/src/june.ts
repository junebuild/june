#!/usr/bin/env bun
// The `june` bin. Thin: parse argv → run(). Long-running commands (dev) resolve
// to undefined so we do NOT exit and the server keeps the process alive.
import { run } from "./cli";

run(process.argv.slice(2))
  .then((code) => {
    if (code !== undefined) process.exit(code);
  })
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
