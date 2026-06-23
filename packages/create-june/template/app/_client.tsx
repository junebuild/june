// The client entry (app/_client.* convention). Its presence turns on /client.js;
// delete it and every page ships zero client JS. startJuneClient hydrates the
// islands and wires the router when clientRouter is on. ISLAND_LOADERS is
// generated from your island() modules.
import { startJuneClient } from "@junejs/core/islands-client";

import { ISLAND_LOADERS } from "./_islands.gen";

startJuneClient({ loaders: ISLAND_LOADERS });
