// @junejs/db — the ambient data resources. Decoupled from ctx (which is identity
// only): `import { db } from "@junejs/db"` and use it in any loader, view, model,
// or action. The host (@junejs/server) opens the resources and runs each request
// in the scope these read; this package is the worker-safe seam they cross.

export { db, kv, blob, runInScope, ensureScope, requestLocal, type RequestScope } from "./scope";
