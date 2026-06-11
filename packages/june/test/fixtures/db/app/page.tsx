import { route } from "@junejs/core/route";

// A route that reads the injected `db` resource. When no resource is declared,
// ctx.db is undefined and the route degrades gracefully.
export default route({
  load: async (ctx) => {
    if (!ctx.db) return { users: [] as { name: string }[] };
    return { users: await ctx.db.query<{ name: string }>("select name from users order by id") };
  },
  json: (data) => data,
});
