import { defineJune } from "@junejs/core/config";
import { vercel } from "@junejs/server";

// Deploys via the Vercel adapter (Build Output API v3). No db — Vercel v1 scope.
export default defineJune({ deploy: { adapter: vercel() } });
