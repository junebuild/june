// The app's client entry (the app/_client.* convention). Its PRESENCE is the
// switch: dev serves /client.js and the document loads it; absent, the page
// ships zero client JS. The `_` prefix keeps it out of the route scan.
//
// v0.1 is explicit: name → component, written by hand. v0.2 generates this
// registry from `"use client"` files.
import { hydrateIslands } from "@junejs/core/islands-client";

import { Counter } from "./Counter";

hydrateIslands({ Counter });

// PoC: intent-based islands, CODE-SPLIT + AUTO-REGISTERED. ISLAND_LOADERS is
// generated from the "use client" island() modules (app/_islands.gen.ts) — no
// hand-written name→import map. Each entry is a lazy `() => import(...)`, so
// rolldown emits one chunk per island and a page downloads only what it renders.
import { hydrateIslandsLazy } from "@junejs/core/islands-client";

import { ISLAND_LOADERS } from "./_islands.gen";

hydrateIslandsLazy(ISLAND_LOADERS);
