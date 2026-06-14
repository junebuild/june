// A page: the default export is the view (it receives the loader's data as
// props); named exports configure the other surfaces. No loader → static.
import type { Loaded } from "@junejs/core/route";
import { Island } from "@junejs/core/islands";

import { Counter } from "./Counter";

export const loader = () => ({ message: "Welcome to June" });

export default function Home({ message }: Loaded<typeof loader>) {
  return (
    <main className="mx-auto max-w-2xl p-8">
      <h1 className="text-3xl font-bold">__APP_NAME__</h1>
      <p className="mt-2 text-gray-600">{message}</p>
      <p className="mt-4 text-gray-600">
        This page also answers as <a className="underline" href="/.json">JSON</a> and{" "}
        <a className="underline" href="/.md">Markdown</a>, and exposes its actions to agents at{" "}
        <code className="rounded bg-gray-100 px-1">/mcp</code>.
      </p>
      {/* A client island: only this subtree hydrates (app/_client.tsx registers it). */}
      <div className="mt-6">
        <Island name="Counter" component={Counter} props={{ initial: 0 }} />
      </div>
    </main>
  );
}

// .json auto-derives from the loader data; no export needed.
export const metadata = { title: "__APP_NAME__" };
