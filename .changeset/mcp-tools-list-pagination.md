---
"@junejs/core": patch
---

MCP connections read a paginated `tools/list` to the end.

`connectMcp` read only the first page of `tools/list` and never followed
`nextCursor`, so a server that pages its tool list silently lost every tool
after page 1. It now follows the cursor until the server omits it, as the
MCP pagination spec (2026-07-28) describes:

- The cursor is sent back verbatim.
- Only a missing or `null` `nextCursor` ends the listing. An empty string is
  a valid cursor.
- One discovery credential is used for the whole listing.

A server that repeats a cursor, or pages past 100, fails the connection with
an error instead of hanging or silently truncating. Servers that don't
paginate make exactly one request, as before.
