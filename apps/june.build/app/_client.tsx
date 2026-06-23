// The client entry. Its presence turns on /client.js + the document's island
// runtime; everything NOT wrapped by island() ships zero client JS. startJuneClient
// hydrates the islands (and wires the router when clientRouter is on); ISLAND_LOADERS
// is generated from the island() modules.
import { startJuneClient } from "@junejs/core/islands-client";

import { ISLAND_LOADERS } from "./_islands.gen";

startJuneClient({ loaders: ISLAND_LOADERS });
