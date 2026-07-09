// A tool IS a defineAction — the same object that is a UI server action and an
// /mcp tool. Discovery adapts it into a runtime Tool. Sync (no ambient db here),
// so it runs exactly-once inside the durability transaction.
import { defineAction } from "@junejs/core/agent";

export default defineAction({
  id: "create_order",
  description: "Place an order for an item.",
  input: {
    type: "object",
    properties: { item: { type: "string" }, qty: { type: "number" } },
    required: ["item"],
  },
  run: (input) => ({ orderId: 1, item: input.item, qty: input.qty ?? 1 }),
});
