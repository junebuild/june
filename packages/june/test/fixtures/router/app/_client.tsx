import { startJuneClient } from "@junejs/core/islands-client";

import { ISLAND_LOADERS } from "./_islands.gen";

startJuneClient({ loaders: ISLAND_LOADERS });
