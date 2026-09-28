---
"@junejs/core": patch
---

MCP connection tool ids are always valid tool names.

MCP allows dots in tool names (`admin.tools.list`, the spec's own example)
and names up to 128 characters, but the `<connection>__<tool>` id June built
from them could then fail the model API's `^[a-zA-Z0-9_-]{1,128}$` rule. A
single invalid id makes the API reject every request from the agent. MCP ids
now use the same reduction as OpenAPI ids: characters outside
`[A-Za-z0-9_-]` become `_` in the whole id (connection name included), ids
are cut to 128 characters, and colliding ids get a numeric suffix.
`tools/call` still sends the server's own tool name.

Names that were already valid keep their ids, for MCP and OpenAPI alike.
Ids are assigned in two passes: every valid `<connection>__<name>` is
reserved first, and only reduced ids are suffixed on a collision. A dotted
`admin.tools.list` listed before `admin_tools_list` therefore gets
`…_admin_tools_list_2`, and never takes the existing tool's id, which would
silently re-route that id's callers to a different remote tool.
