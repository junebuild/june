// The client entry (the app/_client.* convention). Its presence turns on
// /client.js and the document's <script>; delete it and every page ships zero
// client JS. startJuneClient hydrates the islands and (when clientRouter is on)
// wires the router + dev live-reload. ISLAND_LOADERS is generated from the
// island() modules (app/_islands.gen.ts).
import { startJuneClient } from "@junejs/core/islands-client";

import { ISLAND_LOADERS } from "./_islands.gen";

startJuneClient({ loaders: ISLAND_LOADERS });
