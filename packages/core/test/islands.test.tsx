import { describe, expect, test } from "bun:test";
import { serializeIslandProps, deserializeIslandProps } from "@junejs/core/islands";

describe("island prop serialization (the marker contract)", () => {
  test("roundtrips JSON-serializable props", () => {
    const props = { initial: 3, label: "hi", nested: { ok: true } };
    expect(deserializeIslandProps(serializeIslandProps(props))).toEqual(props);
  });

  test("treats absent/empty/garbage props as no props", () => {
    expect(serializeIslandProps(undefined)).toBe("{}");
    expect(deserializeIslandProps(null)).toEqual({});
    expect(deserializeIslandProps("")).toEqual({});
    expect(deserializeIslandProps("not json")).toEqual({});
  });
});
