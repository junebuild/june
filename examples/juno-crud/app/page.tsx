import type { Loaded } from "@junejs/core/route";
import { db } from "@junejs/server"; // the ONE canonical ambient db (auto-tags here)
import { table } from "@junejs/juno"; // ambient typed table — no handle, no ctx

export const loader = async () => {
  // Schema lives in db/migrations/ (applied by `june dev`), so the loader never
  // creates tables. `table("users")` is fully typed — no inline generic — because
  // `june db types` generated db/schema.d.ts from that schema. Seed once if empty.
  const [row] = await db.query<{ c: number }>("select count(*) as c from users");
  if (!row?.c) await db.run("insert into users (name) values ('Ada'), ('Linus'), ('Grace')");
  return { users: await table("users").all() }; // inferred: { id: number; name: string }[]
};

export default function Users({ users }: Loaded<typeof loader>) {
  return (
    <main>
      <h1>Users ({users.length})</h1>
      <ul>
        {users.map((u) => (
          <li key={u.id}>{u.name}</li>
        ))}
      </ul>
    </main>
  );
}

export const metadata = { title: "Users" };
