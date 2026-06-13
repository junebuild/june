// The view, separated from the route — see app/Home.tsx for the pattern.
type User = { id: number; name: string };

export function UsersList({ users }: { users: User[] }) {
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
