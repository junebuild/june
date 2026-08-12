// google-drive.ts — a first-class OUTBOUND integration that gives a June agent
// the ability to read from and write to Google Drive.
//
// Where connections.ts wires a GENERIC remote (any MCP server / OpenAPI doc),
// Google Drive's REST API has quirks the generic OpenAPI client can't honor —
// multipart upload for file CONTENT, `alt=media` downloads, `export` for
// Google-native docs, and a path model that is really a folder graph (Drive has
// no real paths; a "path" is a chain of `name in parents` lookups). So Drive is
// its own small, hand-written client — but it lands in the SAME place every
// other capability does: each operation is a `defineAction`, so the tools join
// the unified registry and are simultaneously an agent tool, a UI server action,
// and an /mcp tool. Nothing new to wire.
//
// June twist (identity, mirrored from connections.ts): the OAuth2 access token is
// resolved PER CALL, server-side, via `auth(ctx)` — it never reaches the model.
// The ctx is the call's identity (ActionContext), so a multi-tenant app can mint
// the CALLER's short-lived token instead of holding one static key. Set
// `requiresPrincipal` when the Drive is user/tenant-scoped and the tools must be
// hidden from anonymous turns entirely.
//
// Pure + web-standard (fetch + URL + JSON, zero node:*), so an agent can hold
// Drive access on the native host and on the edge (a Durable Object) alike.

import { defineAction, type AnyAction, type JsonSchema } from "./agent";
import { defineProviderConnection, type ProviderConnection } from "./connections";
import type { ActionContext } from "./context";

// Resolved per call, server-side — the token never reaches the model. Called
// WITHOUT ctx is not expected here (unlike connections' discovery phase): every
// Drive call happens inside a turn/dispatch that carries identity. Still typed
// optional so a static, single-account token (`auth: () => ({ token })`) is a
// valid one-liner.
export type GoogleDriveAuth = (ctx?: ActionContext) => Promise<{ token: string }> | { token: string };

export type GoogleDriveConfig = {
  // Tool id prefix — the tools are `<name>__read_file`, `<name>__save_file`, …
  // mirroring the connection naming convention. Default "gdrive".
  name?: string;
  // Resolves an OAuth2 access token (scope drive / drive.file) for the call.
  auth: GoogleDriveAuth;
  // Hide every tool from turns without a resolved principal (see connections.ts).
  requiresPrincipal?: boolean;
  // The base folder every PATH operation is relative to (path walkers start here,
  // and `create_file`/`create_folder` default their parent to it). Defaults to
  // Drive's "root" (My Drive). Set this to a shared folder id or a Shared Drive
  // id for the service-account setup — where the target location is NOT the
  // service account's own My Drive root.
  rootFolderId?: string;
  // Overridable for testing / private deployments. Defaults target the public API.
  apiBaseUrl?: string; // default https://www.googleapis.com/drive/v3
  uploadBaseUrl?: string; // default https://www.googleapis.com/upload/drive/v3
  // Injectable fetch (tests, custom transports). Defaults to the global.
  fetch?: typeof fetch;
};

// A trimmed Drive file resource — the fields the tools request and return.
export type DriveFile = {
  id: string;
  name: string;
  mimeType: string;
  modifiedTime?: string;
  size?: string;
  parents?: string[];
  webViewLink?: string;
};

const FOLDER_MIME = "application/vnd.google-apps.folder";
const DEFAULT_API = "https://www.googleapis.com/drive/v3";
const DEFAULT_UPLOAD = "https://www.googleapis.com/upload/drive/v3";
const FILE_FIELDS = "id,name,mimeType,modifiedTime,size,parents,webViewLink";

// Google-native docs cannot be downloaded with alt=media — they must be
// exported. Map each native mime to a sensible text export; everything else is
// downloaded verbatim.
const EXPORT_MIME: Record<string, string> = {
  "application/vnd.google-apps.document": "text/plain",
  "application/vnd.google-apps.spreadsheet": "text/csv",
  "application/vnd.google-apps.presentation": "text/plain",
  "application/vnd.google-apps.script": "application/vnd.google-apps.script+json",
};

// Escape a value for a Drive `q` string literal (single-quoted). Drive's query
// grammar escapes `\` and `'` with a backslash.
function escapeQ(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

// A boundary that cannot collide with textual content.
function boundary(): string {
  return `june${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
}

// One client closure per googleDriveTools() call — shares config, auth, fetch.
function makeClient(config: GoogleDriveConfig) {
  const api = (config.apiBaseUrl ?? DEFAULT_API).replace(/\/$/, "");
  const upload = (config.uploadBaseUrl ?? DEFAULT_UPLOAD).replace(/\/$/, "");
  const doFetch = config.fetch ?? globalThis.fetch;
  const rootId = config.rootFolderId ?? "root";

  async function authHeader(ctx?: ActionContext): Promise<string> {
    const { token } = await config.auth(ctx);
    return `Bearer ${token}`;
  }

  // Fetch + honest error surface: Drive returns a JSON error envelope; bubble
  // its message so the model (and logs) see WHY, not a bare status.
  async function request(url: string, init: RequestInit, ctx?: ActionContext): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set("authorization", await authHeader(ctx));
    const res = await doFetch(url, { ...init, headers });
    if (!res.ok) {
      let detail = "";
      try {
        const body = (await res.clone().json()) as { error?: { message?: string } };
        detail = body?.error?.message ? `: ${body.error.message}` : "";
      } catch {
        try {
          detail = `: ${await res.clone().text()}`;
        } catch {
          /* body already consumed / empty */
        }
      }
      throw new Error(`Google Drive ${init.method ?? "GET"} ${url} failed (${res.status})${detail}`);
    }
    return res;
  }

  async function listFiles(
    params: { q?: string; pageSize?: number; pageToken?: string; orderBy?: string },
    ctx?: ActionContext,
  ): Promise<{ files: DriveFile[]; nextPageToken?: string }> {
    const search = new URLSearchParams({
      fields: `nextPageToken,files(${FILE_FIELDS})`,
      pageSize: String(params.pageSize ?? 50),
      // Traverse shared drives too — a no-op for a plain My Drive account.
      supportsAllDrives: "true",
      includeItemsFromAllDrives: "true",
    });
    if (params.q) search.set("q", params.q);
    if (params.pageToken) search.set("pageToken", params.pageToken);
    if (params.orderBy) search.set("orderBy", params.orderBy);
    const res = await request(`${api}/files?${search}`, { method: "GET" }, ctx);
    return (await res.json()) as { files: DriveFile[]; nextPageToken?: string };
  }

  // Find one direct child of `parentId` by exact name; folderOnly narrows to
  // subfolders (used while walking a path). Drive permits multiple siblings with
  // the same name, so we fetch two and FAIL on ambiguity rather than silently
  // picking one — otherwise save_file could overwrite an unrelated duplicate.
  async function findChild(
    parentId: string,
    name: string,
    opts: { folderOnly?: boolean } = {},
    ctx?: ActionContext,
  ): Promise<DriveFile | null> {
    const clauses = [`name = '${escapeQ(name)}'`, `'${escapeQ(parentId)}' in parents`, "trashed = false"];
    if (opts.folderOnly) clauses.push(`mimeType = '${FOLDER_MIME}'`);
    const { files } = await listFiles({ q: clauses.join(" and "), pageSize: 2 }, ctx);
    if (files.length > 1) {
      throw new Error(`Ambiguous name "${name}"${opts.folderOnly ? " (folder)" : ""}: ${files.length} matches in the same parent — resolve by fileId instead of path.`);
    }
    return files[0] ?? null;
  }

  // Resolve a slash path of FOLDER segments to a folder id (mkdir -p), starting
  // at the configured root (or a supplied startId): missing folders are created.
  // Used by the write paths (create/save/create_folder); reads walk with
  // findChild instead so an absent folder is a genuine null, never a create.
  async function resolveFolderPath(segments: string[], opts: { startId?: string } = {}, ctx?: ActionContext): Promise<string> {
    let parent = opts.startId ?? rootId;
    for (const segment of segments) {
      if (!segment || segment === ".") continue;
      const existing = await findChild(parent, segment, { folderOnly: true }, ctx);
      if (existing) {
        parent = existing.id;
        continue;
      }
      const created = await createMetadata({ name: segment, mimeType: FOLDER_MIME, parents: [parent] }, ctx);
      parent = created.id;
    }
    return parent;
  }

  // Resolve a full "Folder/Sub/file.txt" path to its file resource, or null when
  // the path genuinely doesn't exist. Walks with findChild directly so that only
  // an ABSENT segment yields null — a real failure (401/403/429/5xx) propagates
  // from `request`, instead of being masked as "not found".
  async function resolvePathToFile(path: string, ctx?: ActionContext): Promise<DriveFile | null> {
    const segments = path.split("/").filter((s) => s && s !== ".");
    if (segments.length === 0) throw new Error("Empty path");
    const name = segments[segments.length - 1]!;
    let parent = rootId;
    for (const folderName of segments.slice(0, -1)) {
      const folder = await findChild(parent, folderName, { folderOnly: true }, ctx);
      if (!folder) return null; // an intermediate folder is absent ⇒ the file can't exist
      parent = folder.id;
    }
    return findChild(parent, name, {}, ctx);
  }

  async function getMetadata(fileId: string, ctx?: ActionContext): Promise<DriveFile> {
    const search = new URLSearchParams({ fields: FILE_FIELDS, supportsAllDrives: "true" });
    const res = await request(`${api}/files/${encodeURIComponent(fileId)}?${search}`, { method: "GET" }, ctx);
    return (await res.json()) as DriveFile;
  }

  // Download a file's textual content. Google-native docs are EXPORTED to a
  // supported text type; a non-exportable native resource (folder, shortcut,
  // form, …) has no content to read, so reject it clearly rather than firing a
  // bogus export request. Everything else is fetched with alt=media.
  async function downloadContent(file: DriveFile, ctx?: ActionContext): Promise<string> {
    if (file.mimeType.startsWith("application/vnd.google-apps.")) {
      const exportMime = EXPORT_MIME[file.mimeType];
      if (!exportMime) {
        throw new Error(`Cannot read content of "${file.name}" — ${file.mimeType} is a Google-native resource with no text export (e.g. a folder or shortcut).`);
      }
      const search = new URLSearchParams({ mimeType: exportMime });
      const res = await request(`${api}/files/${encodeURIComponent(file.id)}/export?${search}`, { method: "GET" }, ctx);
      return res.text();
    }
    const search = new URLSearchParams({ alt: "media", supportsAllDrives: "true" });
    const res = await request(`${api}/files/${encodeURIComponent(file.id)}?${search}`, { method: "GET" }, ctx);
    return res.text();
  }

  // Default a create's parent to the configured root when the caller didn't pin
  // one — so create_file/create_folder land in the shared folder / Shared Drive
  // (service-account setup), not the token's My Drive root.
  function withParent(metadata: { name: string; mimeType?: string; parents?: string[] }) {
    return metadata.parents?.length ? metadata : { ...metadata, parents: [rootId] };
  }

  // Metadata-only create (folders, or empty files). Content-bearing creates go
  // through uploadFile (multipart).
  async function createMetadata(
    metadata: { name: string; mimeType?: string; parents?: string[] },
    ctx?: ActionContext,
  ): Promise<DriveFile> {
    const search = new URLSearchParams({ fields: FILE_FIELDS, supportsAllDrives: "true" });
    const res = await request(
      `${api}/files?${search}`,
      { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(withParent(metadata)) },
      ctx,
    );
    return (await res.json()) as DriveFile;
  }

  // Create a file WITH content in one multipart/related upload (metadata part +
  // media part). This is the "agent creates a file and saves it" path.
  async function uploadFile(
    metadata: { name: string; mimeType?: string; parents?: string[] },
    content: string,
    contentType: string,
    ctx?: ActionContext,
  ): Promise<DriveFile> {
    const b = boundary();
    const body =
      `--${b}\r\n` +
      `Content-Type: application/json; charset=UTF-8\r\n\r\n` +
      `${JSON.stringify(withParent(metadata))}\r\n` +
      `--${b}\r\n` +
      `Content-Type: ${contentType}\r\n\r\n` +
      `${content}\r\n` +
      `--${b}--`;
    const search = new URLSearchParams({ uploadType: "multipart", fields: FILE_FIELDS, supportsAllDrives: "true" });
    const res = await request(
      `${upload}/files?${search}`,
      { method: "POST", headers: { "content-type": `multipart/related; boundary=${b}` }, body },
      ctx,
    );
    return (await res.json()) as DriveFile;
  }

  // Replace an existing file's content (simple media upload).
  async function updateContent(
    fileId: string,
    content: string,
    contentType: string,
    ctx?: ActionContext,
  ): Promise<DriveFile> {
    const search = new URLSearchParams({ uploadType: "media", fields: FILE_FIELDS, supportsAllDrives: "true" });
    const res = await request(
      `${upload}/files/${encodeURIComponent(fileId)}?${search}`,
      { method: "PATCH", headers: { "content-type": contentType }, body: content },
      ctx,
    );
    return (await res.json()) as DriveFile;
  }

  async function deleteFile(fileId: string, ctx?: ActionContext): Promise<void> {
    const search = new URLSearchParams({ supportsAllDrives: "true" });
    await request(`${api}/files/${encodeURIComponent(fileId)}?${search}`, { method: "DELETE" }, ctx);
  }

  return {
    listFiles,
    findChild,
    resolveFolderPath,
    resolvePathToFile,
    getMetadata,
    downloadContent,
    createMetadata,
    uploadFile,
    updateContent,
    deleteFile,
  };
}

// Build the set of Drive tools. Returns an array of defineActions — spread it
// into a runtime's `tools`, or default-export it from `agent/tools/gdrive.ts`
// (the directory convention flattens an array export).
export function googleDriveTools(config: GoogleDriveConfig): AnyAction[] {
  const name = config.name ?? "gdrive";
  const client = makeClient(config);
  const gate = config.requiresPrincipal ? { requiresPrincipal: true as const } : {};

  const stringProp = (description: string) => ({ type: "string", description }) as const;

  const listFiles = defineAction({
    id: `${name}__list_files`,
    description:
      "List or search files and folders in Google Drive. Provide a Drive `query` (Drive query syntax, e.g. \"name contains 'report'\") and/or a `folderId` to list a folder's direct children.",
    input: {
      type: "object",
      properties: {
        query: stringProp("Optional Drive query expression, e.g. \"name contains 'notes' and mimeType != 'application/vnd.google-apps.folder'\"."),
        folderId: stringProp("Optional folder id whose direct children to list. Use 'root' for My Drive root."),
        pageSize: { type: "integer", description: "Max results (default 50)." },
        pageToken: stringProp("Token from a previous call's nextPageToken to fetch the next page."),
      },
    },
    annotations: { readOnlyHint: true, title: "List Drive files" },
    ...gate,
    run: async (input, ctx) => {
      const clauses: string[] = ["trashed = false"];
      if (input.folderId) clauses.push(`'${escapeQ(input.folderId)}' in parents`);
      if (input.query) clauses.push(`(${input.query})`);
      return client.listFiles(
        { q: clauses.join(" and "), pageSize: input.pageSize, pageToken: input.pageToken, orderBy: "folder,name" },
        ctx,
      );
    },
  });

  const findFile = defineAction({
    id: `${name}__find_file`,
    description:
      "Find a file or folder by its slash-separated path from the Drive root, e.g. 'Reports/2024/summary.txt'. Returns { found: boolean, file: metadata | null } — `found` is false and `file` is null when nothing exists at that path.",
    input: {
      type: "object",
      properties: { path: stringProp("Slash-separated path from the Drive root, e.g. 'Projects/spec.md'.") },
      required: ["path"],
    },
    annotations: { readOnlyHint: true, title: "Find Drive file by path" },
    ...gate,
    run: async (input, ctx) => {
      const file = await client.resolvePathToFile(input.path, ctx);
      return { found: file !== null, file };
    },
  });

  const readFile = defineAction({
    id: `${name}__read_file`,
    description:
      "Read a file's text content from Google Drive. Identify it by `fileId` OR by `path` (slash-separated from root). Google Docs/Sheets/Slides are exported to text automatically. Returns { id, name, mimeType, content }.",
    input: {
      type: "object",
      properties: {
        fileId: stringProp("The Drive file id. Provide this OR `path`."),
        path: stringProp("Slash-separated path from the Drive root. Provide this OR `fileId`."),
      },
    },
    annotations: { readOnlyHint: true, title: "Read Drive file" },
    ...gate,
    run: async (input, ctx) => {
      let file: DriveFile | null = null;
      if (input.fileId) file = await client.getMetadata(input.fileId, ctx);
      else if (input.path) file = await client.resolvePathToFile(input.path, ctx);
      else throw new Error("Provide either fileId or path");
      if (!file) throw new Error(`File not found: ${input.path ?? input.fileId}`);
      const content = await client.downloadContent(file, ctx);
      return { id: file.id, name: file.name, mimeType: file.mimeType, content };
    },
  });

  const createFile = defineAction({
    id: `${name}__create_file`,
    description:
      "Create a new file in Google Drive with the given text content. Place it under `folderId` or `folderPath` (a slash path; intermediate folders are created). Returns the created file's metadata.",
    input: {
      type: "object",
      properties: {
        name: stringProp("The new file's name, e.g. 'notes.txt'."),
        content: stringProp("The file's text content. Defaults to empty."),
        mimeType: stringProp("MIME type, e.g. 'text/plain' (default), 'text/markdown', 'application/json'."),
        folderId: stringProp("Parent folder id. Defaults to My Drive root."),
        folderPath: stringProp("Parent folder as a slash path from root; created if missing. Alternative to folderId."),
      },
      required: ["name"],
    },
    annotations: { title: "Create Drive file" },
    ...gate,
    run: async (input, ctx) => {
      const mimeType = input.mimeType ?? "text/plain";
      let parentId = input.folderId;
      if (!parentId && input.folderPath) {
        parentId = await client.resolveFolderPath(input.folderPath.split("/"), {}, ctx);
      }
      const metadata = { name: input.name, mimeType, ...(parentId ? { parents: [parentId] } : {}) };
      return client.uploadFile(metadata, input.content ?? "", mimeType, ctx);
    },
  });

  const updateFile = defineAction({
    id: `${name}__update_file`,
    description: "Replace the text content of an existing Google Drive file, identified by `fileId`. Returns the updated file's metadata.",
    input: {
      type: "object",
      properties: {
        fileId: stringProp("The Drive file id to overwrite."),
        content: stringProp("The new full text content."),
        mimeType: stringProp("MIME type of the content (default 'text/plain')."),
      },
      required: ["fileId", "content"],
    },
    annotations: { title: "Update Drive file" },
    ...gate,
    run: async (input, ctx) => client.updateContent(input.fileId, input.content, input.mimeType ?? "text/plain", ctx),
  });

  const saveFile = defineAction({
    id: `${name}__save_file`,
    description:
      "Save text content to a Google Drive path (upsert): if a file already exists at `path` it is overwritten, otherwise it is created (intermediate folders are created). The natural 'agent produced a file, store it' tool. Returns the file's metadata.",
    input: {
      type: "object",
      properties: {
        path: stringProp("Slash-separated destination path from root, e.g. 'Agent Output/report.md'."),
        content: stringProp("The full text content to write."),
        mimeType: stringProp("MIME type (default 'text/plain')."),
      },
      required: ["path", "content"],
    },
    // No idempotentHint: the upsert is a non-atomic find-then-create/update, so
    // two concurrent identical saves can race into duplicate files (Drive does
    // not enforce unique sibling names). Don't advertise safe-to-retry.
    annotations: { title: "Save Drive file (upsert)" },
    ...gate,
    run: async (input, ctx) => {
      const mimeType = input.mimeType ?? "text/plain";
      const segments = input.path.split("/").filter((s) => s && s !== ".");
      if (segments.length === 0) throw new Error("Empty path");
      const fileName = segments[segments.length - 1]!;
      const parentId = await client.resolveFolderPath(segments.slice(0, -1), {}, ctx);
      const existing = await client.findChild(parentId, fileName, {}, ctx);
      if (existing) {
        const updated = await client.updateContent(existing.id, input.content, mimeType, ctx);
        return { ...updated, created: false };
      }
      const created = await client.uploadFile({ name: fileName, mimeType, parents: [parentId] }, input.content, mimeType, ctx);
      return { ...created, created: true };
    },
  });

  const createFolder = defineAction({
    id: `${name}__create_folder`,
    description: "Create a folder in Google Drive. Provide `parentId`, or `parentPath` (created if missing), or neither for the root.",
    input: {
      type: "object",
      properties: {
        name: stringProp("The folder name."),
        parentId: stringProp("Parent folder id. Defaults to My Drive root."),
        parentPath: stringProp("Parent folder as a slash path from root; created if missing."),
      },
      required: ["name"],
    },
    annotations: { title: "Create Drive folder" },
    ...gate,
    run: async (input, ctx) => {
      let parentId = input.parentId;
      if (!parentId && input.parentPath) {
        parentId = await client.resolveFolderPath(input.parentPath.split("/"), {}, ctx);
      }
      return client.createMetadata({ name: input.name, mimeType: FOLDER_MIME, ...(parentId ? { parents: [parentId] } : {}) }, ctx);
    },
  });

  const deleteFile = defineAction({
    id: `${name}__delete_file`,
    description: "Permanently delete a file or folder from Google Drive by `fileId`. This cannot be undone.",
    input: { type: "object", properties: { fileId: stringProp("The Drive file or folder id to delete.") }, required: ["fileId"] },
    annotations: { title: "Delete Drive file", destructiveHint: true },
    ...gate,
    run: async (input, ctx) => {
      await client.deleteFile(input.fileId, ctx);
      return { deleted: true, fileId: input.fileId };
    },
  });

  return [listFiles, findFile, readFile, createFile, updateFile, saveFile, createFolder, deleteFile];
}

// The connections-family entry point: Google Drive as a PROVIDER connection, so
// it lives beside every other outbound edge (`connections/google-drive.ts`) and
// joins the connection lifecycle — connectAll reports it, isolates its failures,
// and the durable/edge target wires it lazily. Under the hood it's the same
// googleDriveTools client; a ProviderConnection is the seam that lets a remote
// bring its own transport (Drive's multipart/alt=media/path-resolution) while
// still being "a connection". Drop it in a directory:
//
//   // agent/connections/google-drive.ts
//   export default googleDriveConnection({ auth: (ctx) => ({ token: ... }) });
export function googleDriveConnection(config: GoogleDriveConfig): ProviderConnection {
  return defineProviderConnection({
    name: config.name ?? "gdrive",
    url: config.apiBaseUrl ?? DEFAULT_API,
    ...(config.requiresPrincipal ? { requiresPrincipal: true } : {}),
    // Static build — Drive's tool set is known; no discovery I/O. The tools each
    // resolve the caller's token per call via config.auth, server-side. The
    // connection's requiresPrincipal is threaded into every tool's defineAction
    // (via googleDriveTools' config) so the gate is applied at REGISTRATION —
    // making the Flight server reference fail closed too, not just the turn/mcp
    // paths. (An explicit config.requiresPrincipal still wins if set.)
    connect: ({ requiresPrincipal }) =>
      googleDriveTools({ ...config, requiresPrincipal: config.requiresPrincipal ?? requiresPrincipal }),
  });
}

// The JsonSchema type is re-exported for callers assembling custom Drive tools.
export type { JsonSchema };
