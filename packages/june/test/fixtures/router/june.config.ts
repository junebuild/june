import { defineJune } from "@junejs/core/config";

// clientRouter ON — this fixture exercises the opt-in SPA layer end to end:
// soft navigation, per-page island hydration, <Island persist> survival, and
// the nav-generation race fix.
export default defineJune({ clientRouter: true });
