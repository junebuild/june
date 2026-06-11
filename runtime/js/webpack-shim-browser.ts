// Must run before react-server-dom's browser client (it reads
// __webpack_require__.u at module init). Resolves client references to the real
// components from the registry.
import { CLIENT_MODULES } from "../app/_client-manifest";

const req = ((id: string) => CLIENT_MODULES[id]) as ((id: string) => unknown) & {
  u: (id: string) => string;
};
req.u = (id: string) => id;

const g = globalThis as Record<string, unknown>;
g.__webpack_require__ = req;
g.__webpack_chunk_load__ = () => Promise.resolve();
