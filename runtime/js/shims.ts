// Stream <-> string helpers shared by both bundles. React's edge builds only
// expose ReadableStream-based render APIs, so we read/write strings at the V8
// boundary (Rust gets/returns plain strings — no stream marshalling).

export async function streamToString(
  stream: ReadableStream<Uint8Array | string>,
): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let out = "";

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    out += typeof value === "string" ? value : decoder.decode(value, { stream: true });
  }

  out += decoder.decode();
  return out;
}

export function streamFromString(text: string): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}
