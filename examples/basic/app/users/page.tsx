import { route } from "@junejs/core/route";
import { defineAction } from "@junejs/core/agent";

type User = { id: number; name: string };
const users: User[] = [
  { id: 1, name: "Ada" },
  { id: 2, name: "Linus" },
];

// One definition, surfaced three ways (UI action · /mcp tool · browser WebMCP
// tool). Registered when this module loads (dev warmup).
export const createUser = defineAction({
  id: "createUser",
  description: "Create a user",
  input: {
    type: "object",
    properties: { name: { type: "string", description: "Display name" } },
    required: ["name"],
  },
  run: ({ name }: { name: string }): User => ({ id: users.length + 1, name }),
});

export default route({
  load: () => ({ users }),
  view: (data) => (
    <main>
      <h1>Users</h1>
      <ul>
        {data.users.map((u) => (
          <li key={u.id}>{u.name}</li>
        ))}
      </ul>
    </main>
  ),
  json: (data) => data,
  metadata: { title: "Users" },
});
