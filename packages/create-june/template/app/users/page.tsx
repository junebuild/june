import { route } from "junecore/route";
import { defineAction, manifest } from "junecore/agent";

type User = { id: number; name: string };
const users: User[] = [
  { id: 1, name: "Ada" },
  { id: 2, name: "Grace" },
];

// One definition, surfaced as a UI action AND an MCP tool an agent can call.
export const createUser = defineAction({
  id: "createUser",
  description: "Create a user",
  input: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
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
  agent: (data) => manifest.resource("users", data.users).actions([createUser]),
  metadata: { title: "Users" },
});
