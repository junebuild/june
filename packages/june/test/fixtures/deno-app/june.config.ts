import { defineJune } from "@junejs/core/config";
import { deno } from "@junejs/server";

// Deno Deploy via the deno() adapter: the same portable bundle, served by
// Deno.serve with in-process static-asset serving.
export default defineJune({ site: { name: "Deno App" }, deploy: { adapter: deno({ org: "myorg", app: "june-deno-app" }) } });
