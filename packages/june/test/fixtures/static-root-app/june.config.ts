import { defineJune } from "@junejs/core/config";

// A static site at a domain root with a known public origin — the agent catalogs
// (ARD, Agent Skills) prerender as files naming that origin.
export default defineJune({
  site: { name: "Static Root", description: "A static site at the domain root." },
  deploy: { target: "static", domain: "static.example" },
});
