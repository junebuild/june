import { describe, expect, test } from "bun:test";
import { route, isRouteDefinition, resolveProjection, routeFromModule } from "@junejs/core/route";

describe("route()", () => {
  test("brands a definition so isRouteDefinition recognizes it", () => {
    const def = route({ load: () => ({ ok: true }), view: () => null });
    expect(isRouteDefinition(def)).toBe(true);
    expect(isRouteDefinition({ load: () => null })).toBe(false);
    expect(isRouteDefinition(null)).toBe(false);
  });

  test("preserves all projections passed in", () => {
    const def = route({
      load: () => ({ n: 1 }),
      view: () => null,
      json: (d) => d,
      md: () => "# hi",
    });
    expect(typeof def.view).toBe("function");
    expect(typeof def.json).toBe("function");
    expect(typeof def.md).toBe("function");
  });
});

describe("resolveProjection() content negotiation", () => {
  test("json prefers json, falls back to view", () => {
    expect(resolveProjection(route({ json: (d) => d }), "json")).toBe("json");
    expect(resolveProjection(route({ view: () => null }), "json")).toBe("view");
  });

  test("view stays view when present", () => {
    expect(resolveProjection(route({ view: () => null }), "view")).toBe("view");
  });

  test("md degrades to json (auto-derived) when md() is absent", () => {
    expect(resolveProjection(route({ json: (d) => d }), "md")).toBe("json");
    expect(resolveProjection(route({ md: () => "x" }), "md")).toBe("md");
  });

  test("an empty route falls through to view", () => {
    expect(resolveProjection(route({}), "json")).toBe("view");
  });
});

describe("routeFromModule() staticPaths (static-target prerender enumeration)", () => {
  test("passes a staticPaths export through to the branded route", () => {
    const paths = ["/guide/a", "/de/guide/a"];
    const def = routeFromModule({ default: () => null, staticPaths: paths });
    expect(def?.staticPaths).toBe(paths);
  });

  test("a module with ONLY staticPaths is still recognized as a route", () => {
    // A dynamic catch-all may configure nothing but its prerender list.
    const def = routeFromModule({ staticPaths: () => ["/x"] });
    expect(def).not.toBeNull();
    expect(typeof def?.staticPaths).toBe("function");
  });

  test("a plain non-route module is still null (no staticPaths → no route)", () => {
    expect(routeFromModule({ notARoute: true })).toBeNull();
  });
});
