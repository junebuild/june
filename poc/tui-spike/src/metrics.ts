// What the harness asserts on. Written as JSON to $TUI_SPIKE_REPORT on exit,
// after the renderer has restored the terminal.

export const metrics = {
  mounts: 0,
  events: 0,
  activeSubscriptions: 0,
  maxActiveSubscriptions: 0,
  suspends: 0,
  resumes: 0,
  editorExit: null as number | null,
  sizes: [] as [number, number][],
  exitReason: "",
};

export type Report = typeof metrics & {
  platform: string;
  arch: string;
  bun: string;
  widthMethod: string;
  frames: { count: number; avgMs: number; maxMs: number; fps: number } | null;
};
