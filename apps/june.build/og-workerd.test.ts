// The workerd og:image path (app/_og.tsx) under bun. workers-og's WASM only runs
// on workerd, so it is replaced by a fake that builds headers EXACTLY as
// workers-og 0.0.27 does — {"Content-Type", "Cache-Control", ...options.headers}
// — which is how production once served `content-type: image/png, image/png`.
// Only workers-og is mocked (mock.module is process-wide; site.test.ts needs the
// real og-card), and fetch is stubbed for this test alone so no font is fetched.
import { afterEach, expect, mock, test } from "bun:test";

import { OG_HEADERS } from "./app/og-card";

mock.module("workers-og", () => ({
  ImageResponse: class {
    constructor(_element: unknown, r: { headers?: Record<string, string> }) {
      return new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), {
        headers: {
          "Content-Type": "image/png",
          "Cache-Control": "public, immutable, no-transform, max-age=31536000",
          ...r.headers,
        },
      });
    }
  },
}));

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

test("the workerd og:image response carries exactly one content-type and cache-control", async () => {
  // The Google Fonts CSS, then the font file it points at.
  globalThis.fetch = (async (input: RequestInfo | URL) =>
    String(input).includes("fonts.googleapis.com")
      ? new Response("src: url(https://fonts.example/f.ttf)")
      : new Response(new ArrayBuffer(8))) as typeof fetch;

  const { ogResponse } = await import("./app/_og");
  // A title no other test renders, so the stub font can't reach their font memo.
  const res = await ogResponse({ title: "og-workerd header regression", tag: "test" });
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toBe("image/png");
  expect(res.headers.get("cache-control")).toBe(OG_HEADERS["cache-control"]);
});
