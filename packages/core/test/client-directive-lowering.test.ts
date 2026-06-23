// island()'s `client:visible` intent is NOT a transform we own — it relies on the
// toolchain lowering the JSX namespaced attribute to the string-keyed prop
// `"client:visible": true`, which the wrapper reads at runtime (islands.tsx). That
// is an implicit contract; pin it so a toolchain/JSX-runtime change can't silently
// break the directive. (The runtime READS side is covered by islands.test.tsx.)
import { describe, expect, test } from "bun:test";

describe("client:* directive lowering (implicit toolchain contract)", () => {
  test("the JSX namespaced attr lowers to a string-keyed boolean prop", () => {
    const out = new Bun.Transpiler({ loader: "tsx" }).transformSync(
      "export const el = <Counter client:visible initial={0} />;",
    );
    // The directive survives as the prop key the wrapper strips + reads.
    expect(out).toContain('"client:visible": true');
    // A real prop is untouched alongside it.
    expect(out).toContain("initial: 0");
  });

  test("each strategy lowers the same way", () => {
    const t = new Bun.Transpiler({ loader: "tsx" });
    for (const s of ["load", "idle", "visible", "only"]) {
      const out = t.transformSync(`export const el = <C client:${s} />;`);
      expect(out).toContain(`"client:${s}": true`);
    }
  });
});
