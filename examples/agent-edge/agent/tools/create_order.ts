// A tool IS a defineAction — the same object a June app serves as a UI server
// action and an /mcp tool. `june gen` compiles this directory into
// _agent.gen.ts, which imports the file statically (fs discovery is a
// dev/build-time thing; the edge bundle needs static imports).
import { defineAction } from "@junejs/core/agent";

export default defineAction({
  id: "create_order",
  description: "Place an order for an item.",
  input: { type: "object", properties: { item: { type: "string" }, qty: { type: "number" } }, required: ["item"] },
  run: (input) => ({ orderId: 1, item: input.item, qty: input.qty ?? 1 }),
});
