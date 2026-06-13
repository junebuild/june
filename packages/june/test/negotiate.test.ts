import { describe, expect, test } from "bun:test";
import { negotiate as neg } from "../src/negotiate";

function req(url: string, headers?: Record<string, string>) {
  return new Request(url, { headers });
}

describe("negotiate()", () => {
  test("a URL extension picks the target and is stripped from the pathname", () => {
    expect(neg(new URL("http://x/users.json"), req("http://x/users.json"))).toMatchObject({
      target: "json",
      pathname: "/users",
    });
    expect(neg(new URL("http://x/posts/a.md"), req("http://x/posts/a.md"))).toMatchObject({
      target: "md",
      pathname: "/posts/a",
    });
  });

  test("the Accept header is the fallback when there is no extension", () => {
    expect(neg(new URL("http://x/users"), req("http://x/users", { accept: "application/json" })).target).toBe("json");
    expect(neg(new URL("http://x/users"), req("http://x/users", { accept: "text/markdown" })).target).toBe("md");
  });

  test("an extension wins over the Accept header", () => {
    const r = neg(new URL("http://x/users.json"), req("http://x/users.json", { accept: "text/markdown" }));
    expect(r.target).toBe("json");
  });

  test("defaults to view", () => {
    expect(neg(new URL("http://x/users"), req("http://x/users")).target).toBe("view");
  });

  test("Sec-Purpose marks the request speculative", () => {
    expect(neg(new URL("http://x/"), req("http://x/", { "sec-purpose": "prefetch" })).speculative).toBe(true);
    expect(neg(new URL("http://x/"), req("http://x/")).speculative).toBe(false);
  });
});
