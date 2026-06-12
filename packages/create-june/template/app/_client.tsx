// The client entry (the app/_client.* convention). Its presence turns on
// /client.js and the document's <script>; delete it and every page ships zero
// client JS. Register each island by the name its <Island> uses.
import { hydrateIslands } from "@junejs/core/islands-client";

import { Counter } from "./Counter";

hydrateIslands({ Counter });
