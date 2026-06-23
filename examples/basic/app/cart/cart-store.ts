// A shared store module — imported by BOTH islands below. Not an island itself; just
// a singleton they coordinate through. (Client state; seed per-request via props.)
import { createStore } from "@junejs/core/store";

export const cartStore = createStore<string[]>([]);
