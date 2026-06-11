import { describe, expect, test } from "bun:test";
import { route, isRouteDefinition, resolveProjection } from "@junejs/core/route";

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
      agent: (d) => d,
      md: () => "# hi",
    });
    expect(typeof def.view).toBe("function");
    expect(typeof def.json).toBe("function");
    expect(typeof def.agent).toBe("function");
    expect(typeof def.md).toBe("function");
  });
});

describe("resolveProjection() content negotiation", () => {
  test("agent degrades to json then view when agent() is absent", () => {
    const onlyJson = route({ json: (d) => d });
    expect(resolveProjection(onlyJson, "agent")).toBe("json");

    const onlyView = route({ view: () => null });
    expect(resolveProjection(onlyView, "agent")).toBe("view");
  });

  test("json prefers json, falls back to agent, then view", () => {
    expect(resolveProjection(route({ json: (d) => d }), "json")).toBe("json");
    expect(resolveProjection(route({ agent: (d) => d }), "json")).toBe("agent");
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
    expect(resolveProjection(route({}), "agent")).toBe("view");
  });
});
