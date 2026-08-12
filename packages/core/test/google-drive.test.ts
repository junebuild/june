// google-drive.test.ts — the Drive tools turn Drive REST calls into unified
// defineActions. A single in-memory fake stands in for Drive (files + folders,
// query subset, multipart/media upload, export/alt=media download); the
// assertions cover the read/create/save/path-resolution/delete tools, that the
// bearer token is resolved server-side per call (never in the tool input), and
// that requiresPrincipal stamps every tool.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { ACTION_REGISTRY } from "@junejs/core/agent";
import { googleDriveTools } from "@junejs/core/google-drive";

// googleDriveTools registers defineActions in the global registry — isolate.
let preexisting = new Map(ACTION_REGISTRY);
beforeEach(() => {
  preexisting = new Map(ACTION_REGISTRY);
  ACTION_REGISTRY.clear();
});
afterEach(() => {
  ACTION_REGISTRY.clear();
  for (const [id, a] of preexisting) ACTION_REGISTRY.set(id, a);
});

const API = "https://www.googleapis.com/drive/v3";
const UPLOAD = "https://www.googleapis.com/upload/drive/v3";

type FakeFile = { id: string; name: string; mimeType: string; parents: string[]; content: string; trashed: boolean };

// A tiny in-memory Drive: enough of the query grammar (name =, in parents,
// mimeType =, trashed = false, name contains) + multipart/media upload +
// export/alt=media download for the tools to exercise real code paths.
function makeFakeDrive() {
  const files = new Map<string, FakeFile>();
  let seq = 0;
  const authSeen: (string | undefined)[] = [];

  const project = (f: FakeFile) => ({ id: f.id, name: f.name, mimeType: f.mimeType, parents: f.parents, modifiedTime: "2024-01-01T00:00:00Z" });

  function matches(f: FakeFile, q: string): boolean {
    if (f.trashed) return false;
    // Split on " and " (the tools only ever AND clauses). `(...)` user query
    // wrappers are stripped for this fake.
    const clauses = q.split(" and ").map((c) => c.trim().replace(/^\((.*)\)$/, "$1"));
    for (const c of clauses) {
      if (c === "trashed = false") continue;
      let m: RegExpMatchArray | null;
      if ((m = c.match(/^name = '(.*)'$/))) {
        if (f.name !== m[1]!.replace(/\\'/g, "'").replace(/\\\\/g, "\\")) return false;
      } else if ((m = c.match(/^'(.*)' in parents$/))) {
        if (!f.parents.includes(m[1]!)) return false;
      } else if ((m = c.match(/^mimeType = '(.*)'$/))) {
        if (f.mimeType !== m[1]) return false;
      } else if ((m = c.match(/^name contains '(.*)'$/))) {
        if (!f.name.includes(m[1]!)) return false;
      }
    }
    return true;
  }

  const fetch = (async (url: string, init?: RequestInit) => {
    const u = new URL(url);
    const method = (init?.method ?? "GET").toUpperCase();
    const headers = new Headers(init?.headers);
    authSeen.push(headers.get("authorization") ?? undefined);
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

    // LIST — GET /drive/v3/files?q=...
    if (u.href.startsWith(`${API}/files`) && method === "GET" && !u.pathname.match(/\/files\/[^/]+/)) {
      const q = u.searchParams.get("q") ?? "";
      const hits = [...files.values()].filter((f) => matches(f, q)).map(project);
      return json({ files: hits });
    }

    // EXPORT — GET /drive/v3/files/{id}/export
    let m = u.pathname.match(/\/files\/([^/]+)\/export$/);
    if (m && method === "GET") {
      const f = files.get(decodeURIComponent(m[1]!));
      if (!f) return new Response("not found", { status: 404 });
      return new Response(`EXPORTED:${f.content}`, { status: 200 });
    }

    // GET one — metadata (fields set) or media (alt=media)
    m = u.pathname.match(/^\/drive\/v3\/files\/([^/]+)$/);
    if (m && method === "GET") {
      const f = files.get(decodeURIComponent(m[1]!));
      if (!f) return json({ error: { message: "File not found" } }, 404);
      if (u.searchParams.get("alt") === "media") return new Response(f.content, { status: 200 });
      return json(project(f));
    }

    // DELETE
    if (m && method === "DELETE") {
      files.delete(decodeURIComponent(m[1]!));
      return new Response(null, { status: 204 });
    }

    // CREATE metadata-only — POST /drive/v3/files
    if (u.href.startsWith(`${API}/files`) && method === "POST") {
      const meta = JSON.parse(String(init!.body)) as { name: string; mimeType?: string; parents?: string[] };
      const id = `id-${++seq}`;
      const f: FakeFile = { id, name: meta.name, mimeType: meta.mimeType ?? "application/octet-stream", parents: meta.parents ?? [], content: "", trashed: false };
      files.set(id, f);
      return json(project(f));
    }

    // MULTIPART upload — POST /upload/drive/v3/files?uploadType=multipart
    if (u.href.startsWith(`${UPLOAD}/files`) && method === "POST") {
      const raw = String(init!.body);
      const metaMatch = raw.match(/application\/json; charset=UTF-8\r\n\r\n([\s\S]*?)\r\n--/);
      const meta = JSON.parse(metaMatch![1]!) as { name: string; mimeType?: string; parents?: string[] };
      const parts = raw.split(/\r\n--/);
      const mediaPart = parts[1] ?? "";
      const content = mediaPart.replace(/^[\s\S]*?\r\n\r\n/, "");
      const id = `id-${++seq}`;
      const f: FakeFile = { id, name: meta.name, mimeType: meta.mimeType ?? "text/plain", parents: meta.parents ?? [], content, trashed: false };
      files.set(id, f);
      return json(project(f));
    }

    // MEDIA update — PATCH /upload/drive/v3/files/{id}?uploadType=media
    m = u.pathname.match(/\/upload\/drive\/v3\/files\/([^/]+)$/);
    if (m && method === "PATCH") {
      const f = files.get(decodeURIComponent(m[1]!));
      if (!f) return json({ error: { message: "File not found" } }, 404);
      f.content = String(init!.body);
      return json(project(f));
    }

    return json({ error: { message: `unhandled ${method} ${u.href}` } }, 500);
  }) as unknown as typeof globalThis.fetch;

  return { fetch, files, authSeen, addFolder(name: string, parent = "root") { const id = `folder-${name}`; files.set(id, { id, name, mimeType: "application/vnd.google-apps.folder", parents: [parent], content: "", trashed: false }); return id; } };
}

function toolsById(actions: ReturnType<typeof googleDriveTools>) {
  return Object.fromEntries(actions.map((a) => [a.id, a]));
}

describe("googleDriveTools", () => {
  test("exposes the full capability set with the configured prefix", () => {
    const drive = makeFakeDrive();
    const actions = googleDriveTools({ auth: () => ({ token: "t" }), fetch: drive.fetch });
    expect(actions.map((a) => a.id).sort()).toEqual(
      [
        "gdrive__create_file",
        "gdrive__create_folder",
        "gdrive__delete_file",
        "gdrive__find_file",
        "gdrive__list_files",
        "gdrive__read_file",
        "gdrive__save_file",
        "gdrive__update_file",
      ].sort(),
    );
  });

  test("a custom name prefixes every tool", () => {
    const drive = makeFakeDrive();
    const actions = googleDriveTools({ name: "mydrive", auth: () => ({ token: "t" }), fetch: drive.fetch });
    expect(actions.every((a) => a.id.startsWith("mydrive__"))).toBe(true);
  });

  test("create_file uploads content and read_file reads it back", async () => {
    const drive = makeFakeDrive();
    const t = toolsById(googleDriveTools({ auth: () => ({ token: "t" }), fetch: drive.fetch }));

    const created = (await t.gdrive__create_file!.run({ name: "hello.txt", content: "hi there", mimeType: "text/plain" }, {})) as { id: string; name: string };
    expect(created.name).toBe("hello.txt");

    const read = (await t.gdrive__read_file!.run({ fileId: created.id }, {})) as { content: string; name: string };
    expect(read).toMatchObject({ name: "hello.txt", content: "hi there" });
  });

  test("save_file upserts by path, creating intermediate folders then overwriting", async () => {
    const drive = makeFakeDrive();
    const t = toolsById(googleDriveTools({ auth: () => ({ token: "t" }), fetch: drive.fetch }));

    const first = (await t.gdrive__save_file!.run({ path: "Reports/2024/summary.md", content: "v1" }, {})) as { id: string; created: boolean };
    expect(first.created).toBe(true);
    // The two path folders now exist in Drive.
    const names = [...drive.files.values()].filter((f) => f.mimeType.endsWith("folder")).map((f) => f.name).sort();
    expect(names).toEqual(["2024", "Reports"]);

    const second = (await t.gdrive__save_file!.run({ path: "Reports/2024/summary.md", content: "v2" }, {})) as { id: string; created: boolean };
    expect(second.created).toBe(false);
    expect(second.id).toBe(first.id); // same file overwritten, not duplicated

    const read = (await t.gdrive__read_file!.run({ path: "Reports/2024/summary.md" }, {})) as { content: string };
    expect(read.content).toBe("v2");
  });

  test("find_file resolves a path and reports absence without throwing", async () => {
    const drive = makeFakeDrive();
    const t = toolsById(googleDriveTools({ auth: () => ({ token: "t" }), fetch: drive.fetch }));

    const missing = (await t.gdrive__find_file!.run({ path: "Nope/nothing.txt" }, {})) as { found: boolean; file: unknown };
    expect(missing).toEqual({ found: false, file: null });

    await t.gdrive__save_file!.run({ path: "Docs/a.txt", content: "x" }, {});
    const hit = (await t.gdrive__find_file!.run({ path: "Docs/a.txt" }, {})) as { found: boolean; file: { name: string } };
    expect(hit.found).toBe(true);
    expect(hit.file.name).toBe("a.txt");
  });

  test("read_file EXPORTS Google-native docs instead of downloading media", async () => {
    const drive = makeFakeDrive();
    // A native Google Doc placed directly in root.
    drive.files.set("doc-1", { id: "doc-1", name: "Plan", mimeType: "application/vnd.google-apps.document", parents: ["root"], content: "body", trashed: false });
    const t = toolsById(googleDriveTools({ auth: () => ({ token: "t" }), fetch: drive.fetch }));

    const read = (await t.gdrive__read_file!.run({ fileId: "doc-1" }, {})) as { content: string };
    expect(read.content).toBe("EXPORTED:body"); // went through the export endpoint
  });

  test("list_files scopes to a folder's children", async () => {
    const drive = makeFakeDrive();
    const folder = drive.addFolder("Inbox");
    drive.files.set("f1", { id: "f1", name: "one.txt", mimeType: "text/plain", parents: [folder], content: "1", trashed: false });
    drive.files.set("f2", { id: "f2", name: "two.txt", mimeType: "text/plain", parents: ["root"], content: "2", trashed: false });
    const t = toolsById(googleDriveTools({ auth: () => ({ token: "t" }), fetch: drive.fetch }));

    const res = (await t.gdrive__list_files!.run({ folderId: folder }, {})) as { files: { name: string }[] };
    expect(res.files.map((f) => f.name)).toEqual(["one.txt"]);
  });

  test("delete_file removes the file", async () => {
    const drive = makeFakeDrive();
    const t = toolsById(googleDriveTools({ auth: () => ({ token: "t" }), fetch: drive.fetch }));
    const created = (await t.gdrive__create_file!.run({ name: "temp.txt", content: "x" }, {})) as { id: string };
    expect(drive.files.has(created.id)).toBe(true);
    const res = (await t.gdrive__delete_file!.run({ fileId: created.id }, {})) as { deleted: boolean };
    expect(res.deleted).toBe(true);
    expect(drive.files.has(created.id)).toBe(false);
  });

  test("the bearer token is resolved server-side per call and never appears in tool input", async () => {
    const drive = makeFakeDrive();
    const authCtxs: unknown[] = [];
    const t = toolsById(
      googleDriveTools({
        auth: (ctx) => {
          authCtxs.push(ctx);
          const user = (ctx as { user?: { id?: string } } | undefined)?.user;
          return { token: user?.id ? `tenant-${user.id}` : "svc" };
        },
        fetch: drive.fetch,
      }),
    );

    await t.gdrive__create_file!.run({ name: "a.txt", content: "x" }, { user: { id: "acme" } });
    // auth saw the CALL's identity; the request carried the minted bearer token.
    expect(authCtxs.at(-1)).toEqual({ user: { id: "acme" } });
    expect(drive.authSeen.some((h) => h === "Bearer tenant-acme")).toBe(true);
  });

  test("requiresPrincipal stamps every tool", () => {
    const drive = makeFakeDrive();
    const actions = googleDriveTools({ auth: () => ({ token: "t" }), requiresPrincipal: true, fetch: drive.fetch });
    expect(actions.every((a) => a.requiresPrincipal === true)).toBe(true);
  });

  test("read/find/list carry the readOnlyHint; delete carries destructiveHint", () => {
    const drive = makeFakeDrive();
    const t = toolsById(googleDriveTools({ auth: () => ({ token: "t" }), fetch: drive.fetch }));
    expect(t.gdrive__read_file!.annotations?.readOnlyHint).toBe(true);
    expect(t.gdrive__list_files!.annotations?.readOnlyHint).toBe(true);
    expect(t.gdrive__delete_file!.annotations?.destructiveHint).toBe(true);
  });

  test("a Drive API error surfaces its message (not a bare status)", async () => {
    const drive = makeFakeDrive();
    const t = toolsById(googleDriveTools({ auth: () => ({ token: "t" }), fetch: drive.fetch }));
    await expect(t.gdrive__read_file!.run({ fileId: "does-not-exist" }, {})).rejects.toThrow("File not found");
  });
});
