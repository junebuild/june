import type { Loaded } from "@junejs/core/route";
import { db } from "@junejs/server"; // the ONE canonical ambient db (auto-tags here)
import { table } from "@junejs/juno"; // ambient typed table — no handle, no ctx

type User = { id: number; name: string };

export const loader = async () => {
  await db.exec("create table if not exists users (id integer primary key, name text)");
  const [row] = await db.query<{ c: number }>("select count(*) as c from users");
  if (!row?.c) await db.run("insert into users (name) values ('Ada'), ('Linus'), ('Grace')");
  return { users: await table<User>("users").all() };
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
