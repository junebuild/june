// Types for the Node ESM CSS-Modules loader (a runtime hook, .mjs).
export function initialize(data?: { maps?: Record<string, Record<string, string>> }): void;
export function load(
  url: string,
  context: unknown,
  next: (url: string, context: unknown) => unknown,
): Promise<{ format: string; source: string; shortCircuit: boolean } | unknown>;
