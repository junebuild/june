import type { Loaded } from "@junejs/core/route";
import { defineAction } from "@junejs/core/agent";

type User = { id: number; name: string };
const users: User[] = [
  { id: 1, name: "Ada" },
  { id: 2, name: "Grace" },
];

// One definition, surfaced as a UI action AND an MCP tool (and a browser WebMCP
// tool) an agent can call.
export const createUser = defineAction({
  id: "createUser",
  description: "Create a user",
  input: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
  run: ({ name }: { name: string }): User => ({ id: users.length + 1, name }),
});

export const loader = () => ({ users });

export default function Users({ users }: Loaded<typeof loader>) {
  return (
    <main>
      <h1>Users</h1>
      <ul>
        {users.map((u) => (
          <li key={u.id}>{u.name}</li>
        ))}
      </ul>
    </main>
  );
}

export const metadata = { title: "Users" };
