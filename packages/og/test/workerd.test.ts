// The workerd backend's body path. workers-og's WASM renderer does not run
// under bun, so conformance.test.ts only asserts the envelope and cancels
// before the render. Here workers-og is a stub that records what it was given,
// which covers the delegation itself: when the render starts, what options
// reach workers-og, and how the body ends on success, failure and cancel.
//
// mock.module replaces workers-og for the whole test process. conformance.test.ts
// never constructs it (it cancels before pull), so the stub does not leak there.

import { beforeEach, describe, expect, mock, test } from "bun:test";
import { createElement } from "react";

type Call = { element: unknown; options: Record<string, unknown> };
const calls: Call[] = [];
let render: () => Promise<Uint8Array> = async () => new Uint8Array();

class StubImageResponse extends Response {
  constructor(element: unknown, options: Record<string, unknown>) {
    calls.push({ element, options });
    // Mirrors workers-og: title-case defaults with the caller's headers spread over them.
    const body = new ReadableStream<Uint8Array>({
      async start(controller) {
        try {
          controller.enqueue(await render());
          controller.close();
        } catch (err) {
          controller.error(err);
        }
      },
    });
    super(body, {
      headers: { "Content-Type": "image/png", "Cache-Control": "public, immutable", ...(options.headers as object) },
    });
  }
}

mock.module("workers-og", () => ({ ImageResponse: StubImageResponse }));

const { ImageResponse, OG_HEADERS } = await import("../src/workerd");

const card = () => createElement("div", { style: { display: "flex" } });
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

beforeEach(() => {
  calls.length = 0;
  render = async () => PNG;
});

describe("workerd: body delegation", () => {
  test("the render starts when the body is read, not when the response is built", async () => {
    const res = new ImageResponse(card());
    expect(calls).toHaveLength(0);
    await res.arrayBuffer();
    expect(calls).toHaveLength(1);
  });

  test("the body is workers-og's PNG, the envelope is ours", async () => {
    const res = new ImageResponse(card(), { status: 404, headers: { ...OG_HEADERS } });
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(PNG);
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("cache-control")).toBe(OG_HEADERS["cache-control"]);
  });

  test("render options reach workers-og; headers and status never do", async () => {
    const element = card();
    const fonts = [{ name: "Inter", data: new ArrayBuffer(1), weight: 400 as const, style: "normal" as const }];
    const res = new ImageResponse(element, {
      width: 800,
      height: 400,
      fonts,
      emoji: "noto",
      debug: true,
      status: 201,
      headers: { ...OG_HEADERS, "x-og-variant": "a" },
    });
    await res.arrayBuffer();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.element).toBe(element);
    expect(calls[0]!.options).toEqual({ width: 800, height: 400, fonts, emoji: "noto", debug: true });
  });

  test("a failing render errors the body instead of hanging", async () => {
    render = async () => {
      throw new Error("resvg failed");
    };
    const res = new ImageResponse(card());
    await expect(res.arrayBuffer()).rejects.toThrow("resvg failed");
  });

  test("cancelling during the render drops the bytes without an error", async () => {
    let finish!: (png: Uint8Array) => void;
    render = () => new Promise((resolve) => (finish = resolve));
    const res = new ImageResponse(card());
    const reader = res.body!.getReader();
    const read = reader.read();
    // pull() is now awaiting the render.
    await Bun.sleep(0);
    expect(calls).toHaveLength(1);
    await reader.cancel();
    finish(PNG);
    expect(await read).toEqual({ done: true, value: undefined });
  });
});
