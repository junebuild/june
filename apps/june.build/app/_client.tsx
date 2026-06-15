// The client entry (app/_client.* convention). Its presence turns on /client.js
// and the document's island runtime; everything NOT inside an <Island> still
// ships zero client JS. Register each island by the name its <Island> uses.
import { hydrateIslands } from "@junejs/core/islands-client";

import { HeroViewer } from "./HeroViewer";
import { InstallCmd } from "./InstallCmd";
import { ThemeToggle } from "./ThemeToggle";
import { ViewAs } from "./ViewAs";

hydrateIslands({ HeroViewer, InstallCmd, ThemeToggle, ViewAs });
