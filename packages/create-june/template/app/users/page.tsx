import { route } from "@junejs/core/route";
import { defineAction, manifest } from "@junejs/core/agent";

import { UsersList } from "./UsersList";

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
  view: (data) => <UsersList users={data.users} />,
  json: (data) => data,
  agent: (data) => manifest.resource("users", data.users).actions([createUser]),
  metadata: { title: "Users" },
});
