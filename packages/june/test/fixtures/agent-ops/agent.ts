// agent.ts — agent config. The rest (instructions.md + per-surface variants,
// tools/, skills/, channels/) is discovered from the surrounding directory by
// @junejs/server's discoverAgent.
export default {
  name: "ops",
  model: "claude-opus-4-8",
  description: "An operations assistant that places and looks up orders.",
  // Per-surface mechanics (#149): slack turns compose instructions.slack.md
  // after the base (append default) and mechanically lose create_order — the
  // operator surface reads, it never places orders.
  surfaces: {
    slack: { denyTools: ["create_order"] },
  },
};
