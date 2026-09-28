import { defineJune } from "@junejs/core/config";

// A static root deploy with a public origin but agent discovery OFF, and a
// catch-all route that would answer any path — the build must publish no catalog
// file (not even the catch-all's page under a catalog filename).
export default defineJune({
  site: { name: "No Discovery" },
  agent: { discovery: false },
  deploy: { target: "static", domain: "nodiscovery.example" },
});
