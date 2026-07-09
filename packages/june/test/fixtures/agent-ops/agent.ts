// agent.ts — agent config. The rest (instructions.md, tools/, skills/) is
// discovered from the surrounding directory by @junejs/server's discoverAgent.
export default {
  name: "ops",
  model: "claude-opus-4-8",
  description: "An operations assistant that places and looks up orders.",
};
