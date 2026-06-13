import { route } from "@junejs/core/route";
import { db } from "@junejs/db";

// Reads the AMBIENT `db` (decoupled from ctx). Declaring `resources.db` is
// required to use it; without it the ambient db throws guidance, which the load
// boundary turns into a 404 — a misconfig fails loud rather than silently empty.
export default route({
  load: async () => ({
    users: await db.query<{ name: string }>("select name from users order by id"),
  }),
  json: (data) => data,
});
