import { defineAction } from "@junejs/core/agent";

export default defineAction({
  id: "echo",
  description: "Echo the input back.",
  input: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
  run: (input) => ({ echoed: input.text }),
});
