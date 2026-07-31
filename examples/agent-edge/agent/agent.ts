// agent.ts — agent config. instructions.md, tools/, and channels/ in this
// directory are the rest of the definition; `june gen` compiles the directory
// into _agent.gen.ts so the worker mounts it without fs discovery (workerd has
// no filesystem — discoverAgent is native-only).
export default {
  name: "ops",
  model: "claude-opus-4-8",
  description: "An ordering assistant that places orders.",
};
