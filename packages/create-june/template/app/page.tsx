// A route(): data in via load(), multiple surfaces out. The JSX lives in
// Home.tsx — view() is a one-line adapter, so this file stays about routing.
import { route } from "@junejs/core/route";

import { Home } from "./Home";

export default route({
  load: () => ({ message: "Welcome to June" }),
  view: (data) => <Home message={data.message} />,   // → HTML
  json: (data) => data,                              // → /.json
  metadata: { title: "__APP_NAME__" },
});
