// Ambient declarations for react-server-dom-webpack (it ships no .d.ts) and the
// "june:app" virtual the RSC runtime entries import (aliased at bundle time).
// Minimal — only the surface the runtime entries use.
declare module "react-server-dom-webpack/server" {
  export function renderToReadableStream(
    model: unknown,
    webpackMap?: unknown,
    options?: unknown,
  ): ReadableStream<Uint8Array>;
  export function registerClientReference(
    proxy: object,
    id: string,
    exportName: string,
  ): unknown;
  // "use server" — register a server function so it serializes as a server
  // reference and can be invoked from a decoded client request.
  export function registerServerReference<F>(fn: F, id: string, exportName: string): F;
  export function decodeReply(body: string | FormData, serverManifest?: unknown, options?: unknown): Promise<unknown[]>;
}

declare module "react-server-dom-webpack/client" {
  export function createFromReadableStream(
    stream: ReadableStream<Uint8Array>,
    options?: unknown,
  ): Promise<React.ReactNode> & React.ReactNode;
  // "use server" client half — encode args for a server-function POST.
  export function encodeReply(value: unknown): Promise<string | FormData>;
}

// The app under render, injected by the build (resolve.alias "june:app" → app).
declare module "june:app" {
  import type React from "react";
  export const App: React.ComponentType;
  export const clientManifest: Record<string, unknown> | undefined;
}

// The generated consumer manifest (resolve.alias "june:rsc-client" → app/_rsc-client.gen.ts).
declare module "june:rsc-client" {
  export const MODULE_MAP: Record<string, Record<string, { id: string; chunks: string[]; name: string }>>;
}

// The frozen document config (resolve.alias "june:rsc-config" → generated).
declare module "june:rsc-config" {
  import type { DocumentConfig } from "@junejs/core/document";
  export const DOC_CONFIG: DocumentConfig;
}
