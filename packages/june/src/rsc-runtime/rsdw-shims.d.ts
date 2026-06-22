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
}

declare module "react-server-dom-webpack/client" {
  export function createFromReadableStream(
    stream: ReadableStream<Uint8Array>,
    options?: unknown,
  ): Promise<React.ReactNode> & React.ReactNode;
}

// The app under render, injected by the build (resolve.alias "june:app" → app).
declare module "june:app" {
  import type React from "react";
  export const App: React.ComponentType;
  export const clientManifest: Record<string, unknown> | undefined;
}
