// Client entry. Calling hydrateIslands also starts the client router when the
// document opted in (config.clientRouter → [data-june-root] is on the page).
import { hydrateIslands } from "@junejs/core/islands-client";

import { Counter } from "./Counter";
import { Live } from "./Live";

hydrateIslands({ Counter, Live });
