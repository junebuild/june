import type { Loaded } from "@junejs/core/route";
import { defineAction } from "@junejs/core/agent";
import { db } from "@junejs/db";

type User = { id: number; name: string };

// One definition, surfaced as a UI action AND an MCP tool (and a browser WebMCP
// tool) an agent can call. It writes through the ambient `db` — the same handle
// the loader reads, no request object threaded in.
export const createUser = defineAction({
  id: "createUser",
  description: "Create a user",
  input: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
  run: async ({ name }: { name: string }): Promise<User> => {
    const { lastInsertRowid } = await db.run("insert into users (name) values (?)", [name]);
    return { id: Number(lastInsertRowid), name };
  },
});

export const loader = async () => ({
  users: await db.query<User>("select id, name from users order by id"),
});

export default function Users({ users }: Loaded<typeof loader>) {
  return (
    <main className="mx-auto max-w-2xl p-8">
      <h1 className="text-3xl font-bold">Users</h1>
      <ul className="mt-4 space-y-1 text-gray-700">
        {users.map((u) => (
          <li key={u.id}>{u.name}</li>
        ))}
      </ul>
    </main>
  );
}

export const metadata = { title: "Users" };
