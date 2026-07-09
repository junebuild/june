// An outbound connection to an external MCP server. Its tools become
// weather__<tool> and join the agent's tool set (and its own /mcp — a gateway).
import { defineMcpConnection } from "@junejs/core/connections";

export default defineMcpConnection({ name: "weather", url: "http://mock/mcp" });
