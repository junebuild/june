import {
  registerServerReference,
  registerClientReference,
  renderToReadableStream,
  decodeReply,
} from "react-server-dom-webpack/server";

// A "use server" action (registered by hand for the PoC; codegen comes later).
const add = registerServerReference(
  async (a: number, b: number) => a + b,
  "actions#add",
  "add",
);

// A "use client" button that receives the action as a prop.
const Btn = registerClientReference({}, "Btn#Btn", "Btn") as unknown as React.FC<{ onAct: unknown }>;
const CLIENT_MANIFEST = { "Btn#Btn": { id: "Btn#Btn", chunks: [], name: "Btn" } };

async function streamToString(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const dec = new TextDecoder();
  let out = "";
  for (;;) { const { done, value } = await reader.read(); if (done) break; out += dec.decode(value, { stream: true }); }
  return out + dec.decode();
}

// Flight render where a client component carries the server action as a prop →
// the action serializes as a SERVER reference.
export async function renderWithAction(): Promise<string> {
  return streamToString(renderToReadableStream(<Btn onAct={add} />, CLIENT_MANIFEST));
}

// The server action endpoint: decode the client's encoded args, run the action.
export async function callAdd(body: string | FormData): Promise<unknown> {
  const args = (await decodeReply(body, {})) as [number, number];
  return add(...args);
}
