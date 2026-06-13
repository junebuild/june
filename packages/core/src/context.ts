// Request-scoped IDENTITY shared by routes and actions: the authenticated
// principal + session. PURE — the principal types are abstract; the auth
// integration (@junejs/auth, Better Auth) refines them. @junejs/core never
// imports an auth library; the host populates these off the request.
// See docs/auth-integration.md.
//
// Data resources (db/kv/blob) are NOT here — they are ambient (`import { db }
// from '@junejs/server'`), so domain code never threads ctx. ctx = identity.

// The authenticated user. Abstract on purpose — Better Auth's user shape slots
// in via declaration merging / the auth package's own typing.
export type Principal = { id: string; [key: string]: unknown };
export type Session = { id: string; [key: string]: unknown };

// What a defineAction's run() receives as its SECOND argument: the same
// request-scoped principal a route's load() sees. This is what lets the UI
// dispatch and the /mcp path share ONE authorization model — an agent calling a
// tool runs through the exact same `ctx.user` check as the UI.
export type ActionContext = {
  request?: Request;
  user?: Principal;
  session?: Session;
};
