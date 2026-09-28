import { describe, expect, test } from "bun:test";
import { acceptTarget, negotiate as neg } from "../src/negotiate";

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

  // acceptTarget is shared with withAssets, so worker and pipeline agree.
  test("Accept q-values: an agent projection wins only when at least as preferred as HTML", () => {
    const t = (accept: string) => acceptTarget(accept);
    expect(t("text/markdown")).toBe("md");
    expect(t("text/markdown, text/html;q=0.9")).toBe("md");
    expect(t("text/html, text/markdown;q=0.5")).toBeNull();
    expect(t("text/markdown, */*")).toBe("md"); // tie → the agent projection
    expect(t("text/markdown;q=0.5, */*")).toBeNull(); // HTML's quality comes from */*
    expect(t("text/markdown;q=0")).toBeNull(); // q=0 = not acceptable
    expect(t("text/markdown;q=0.5, application/json")).toBe("json");
    expect(t("application/json, text/markdown")).toBe("md");
    // a browser's Accept never names markdown/json
    expect(t("text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8")).toBeNull();
    expect(t("text/vnd.june.fragment+html")).toBe("fragment");
    // fragment keeps its priority over an equally/more-preferred markdown
    expect(t("text/markdown, text/vnd.june.fragment+html;q=0.5")).toBe("fragment");
  });

  test("the fragment type is matched as a parsed media range, not a substring", () => {
    const t = (accept: string) => acceptTarget(accept);
    expect(t("text/vnd.june.fragment+html;q=0")).toBeNull(); // q=0 = not acceptable
    expect(t("text/vnd.june.fragment+html;q=0, text/markdown")).toBe("md");
    expect(t("text/vnd.june.fragment+html-legacy")).toBeNull(); // lookalike type
    expect(t("application/x-text/vnd.june.fragment+html")).toBeNull();
  });

  // RFC 9110 qvalue grammar; anything else is malformed → the default q=1.
  test("a malformed q reads as the default 1", () => {
    const t = (accept: string) => acceptTarget(accept);
    // numerically 0.1234 < 0.9 would pick HTML; malformed → 1 → markdown
    expect(t("text/html;q=0.9, text/markdown;q=0.1234")).toBe("md");
    // numerically negative would exclude markdown; malformed → 1
    expect(t("text/html;q=0.9, text/markdown;q=-0.5")).toBe("md");
    // out of range: not "more than 1" — just the default 1 (ties go to markdown)
    expect(t("text/html, text/markdown;q=2")).toBe("md");
    expect(t("text/markdown, text/html;q=2")).toBe("md");
    // valid forms still parse: "1." and "0.123"
    expect(t("text/html, text/markdown;q=1.")).toBe("md");
    expect(t("text/html, text/markdown;q=0.123")).toBeNull();
    expect(t("text/html;q=0.1, text/markdown;q=0.123")).toBe("md");
  });

  test("an extension wins over the Accept header", () => {
    const r = neg(new URL("http://x/users.json"), req("http://x/users.json", { accept: "text/markdown" }));
    expect(r.target).toBe("json");
  });

  test("defaults to view", () => {
    expect(neg(new URL("http://x/users"), req("http://x/users")).target).toBe("view");
  });

  test("/index is the conventional alias for the home route /", () => {
    // the home page's projections at the intuitive /index.md · /index.json
    expect(neg(new URL("http://x/index.md"), req("http://x/index.md"))).toMatchObject({
      target: "md",
      pathname: "/",
    });
    expect(neg(new URL("http://x/index.json"), req("http://x/index.json"))).toMatchObject({
      target: "json",
      pathname: "/",
    });
    // plain /index → the home view
    expect(neg(new URL("http://x/index"), req("http://x/index"))).toMatchObject({ target: "view", pathname: "/" });
    // a bare /.md /.json on the root is NOT the home surface (that's /index.md) →
    // the pathname is left literal so no route matches and it 404s.
    expect(neg(new URL("http://x/.md"), req("http://x/.md")).pathname).not.toBe("/");
    expect(neg(new URL("http://x/.json"), req("http://x/.json")).pathname).not.toBe("/");
    // a nested "index" segment is NOT touched (only the top-level /index alias)
    expect(neg(new URL("http://x/docs/index.md"), req("http://x/docs/index.md"))).toMatchObject({
      target: "md",
      pathname: "/docs/index",
    });
  });

  test("Sec-Purpose marks the request speculative", () => {
    expect(neg(new URL("http://x/"), req("http://x/", { "sec-purpose": "prefetch" })).speculative).toBe(true);
    expect(neg(new URL("http://x/"), req("http://x/")).speculative).toBe(false);
  });
});
