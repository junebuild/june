// Backend conformance: the three entrypoints (node / edge-light / workerd) are
// ONE import for consumers — the export condition picks the file, so their
// public surfaces must stay identical or a consumer breaks on the target that
// resolved differently. Same drift class pipeline.ts's parity test guards for
// rendering; this is the OG package's version of it.
//
// The workerd backend re-exports workers-og's ImageResponse, whose render needs
// the workerd runtime — so it participates in the surface-parity checks only.
// The node backend's full render runs here (satori + resvg are devDeps); the
// edge backend's response ENVELOPE (status/headers, set synchronously before
// the lazy @vercel/og import resolves) is asserted without awaiting a render.

import { describe, expect, test } from "bun:test";
import { createElement } from "react";

import * as edge from "../src/edge";
import * as node from "../src/node";
import * as workerd from "../src/workerd";

const runtimeExports = (mod: Record<string, unknown>) => Object.keys(mod).sort();

describe("export surface parity", () => {
  test("all three backends export the same runtime names", () => {
    const nodeKeys = runtimeExports(node);
    expect(runtimeExports(edge)).toEqual(nodeKeys);
    expect(runtimeExports(workerd)).toEqual(nodeKeys);
  });

  test("the shared font utilities are the SAME functions, not copies", () => {
    // All backends re-export from ./fonts — one memory cache, one loader.
    expect(edge.loadGoogleFont).toBe(node.loadGoogleFont);
    expect(workerd.loadGoogleFont).toBe(node.loadGoogleFont);
    expect(edge.loadDefaultFonts).toBe(node.loadDefaultFonts);
    expect(workerd.loadDefaultFonts).toBe(node.loadDefaultFonts);
    expect(edge.hasCJK).toBe(node.hasCJK);
    expect(workerd.hasCJK).toBe(node.hasCJK);
    expect(edge.OG_HEADERS).toBe(node.OG_HEADERS);
    expect(workerd.OG_HEADERS).toBe(node.OG_HEADERS);
  });

  test("node and edge ImageResponse are Response subclasses", () => {
    expect(Object.getPrototypeOf(node.ImageResponse)).toBe(Response);
    expect(Object.getPrototypeOf(edge.ImageResponse)).toBe(Response);
  });
});

// A minimal element satori can render without fonts (no text → no font lookup).
const blankCard = () =>
  createElement("div", {
    style: { width: "100%", height: "100%", display: "flex", backgroundColor: "#663399" },
  });

// The response envelope is written synchronously in the constructor (before any
// lazy backend import resolves), so these assertions hold for both wrapper
// backends without depending on a render. types.ts contract: callers may merge
// or override any header EXCEPT content-type.
const envelopeContract = (name: string, Ctor: typeof node.ImageResponse) => {
  // Drain the body rather than cancel it: cancelling races the in-flight render
  // (the writer would fault on a cancelled stream). A render failure is fine
  // here — the envelope was already asserted, set synchronously before it.
  const drain = (res: Response) => res.arrayBuffer().catch(() => {});

  describe(`${name}: response envelope`, () => {
    test("defaults: 200, image/png, immutable-friendly cache-control", async () => {
      const res = new Ctor(blankCard());
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("image/png");
      expect(res.headers.get("cache-control")).toBe(
        "public, max-age=86400, stale-while-revalidate=604800",
      );
      await drain(res);
    });

    test("caller headers merge, cache-control is overridable", async () => {
      const res = new Ctor(blankCard(), {
        status: 404,
        headers: { "x-og-variant": "missing", "cache-control": "no-store" },
      });
      expect(res.status).toBe(404);
      expect(res.headers.get("x-og-variant")).toBe("missing");
      expect(res.headers.get("cache-control")).toBe("no-store");
      await drain(res);
    });

    test("content-type can NOT be overridden — the body is always served as PNG", async () => {
      const res = new Ctor(blankCard(), { headers: { "content-type": "text/html" } });
      expect(res.headers.get("content-type")).toBe("image/png");
      await drain(res);
    });
  });
};

envelopeContract("node", node.ImageResponse);
envelopeContract("edge", edge.ImageResponse);

describe("node: full render", () => {
  test("renders a PNG with the requested dimensions", async () => {
    const res = new node.ImageResponse(blankCard(), { width: 32, height: 16 });
    const buf = new Uint8Array(await res.arrayBuffer());
    // PNG signature.
    expect([...buf.slice(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    // IHDR width/height are big-endian u32 at offsets 16/20.
    const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    expect(view.getUint32(16)).toBe(32);
    expect(view.getUint32(20)).toBe(16);
  });

  test("a failing render aborts the body instead of hanging", async () => {
    // satori rejects elements with text but no fonts — the constructor's catch
    // must abort the stream so consumers see an error, not an eternal pending.
    const res = new node.ImageResponse(
      createElement("div", { style: { display: "flex" } }, "text needs a font"),
    );
    await expect(res.arrayBuffer()).rejects.toBeDefined();
  });
});
