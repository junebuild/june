---
title: Contact
description: How to reach the June project — GitHub issues for bugs and feature requests, pull requests for changes, and where agents can query this site directly.
---
## Bugs and feature requests

The fastest way to reach the people who build June is the issue tracker at
[github.com/junebuild/june/issues](https://github.com/junebuild/june/issues).
Search the open issues first; if yours is new, include the June version
(`npm ls @junejs/core`), your runtime and deploy target (Bun, Node, Cloudflare
Workers, Vercel, Deno), and the smallest reproduction you can manage. Issues
are public, so leave out secrets, tokens, and private data.

## Contributing

Changes arrive as pull requests against the `main` branch of
[junebuild/june](https://github.com/junebuild/june), and each is reviewed before
it merges. A change to a published `@junejs/*` package carries tests for its
behavior and a changeset (`bun run changeset`) describing the release; a
documentation or site-only change needs neither. Documentation fixes
are welcome too: every page on this site is a Markdown file under
`apps/june.build/content/` in the same repository.

## Security

Please do not report a vulnerability in a public issue. Use GitHub's private
vulnerability reporting on the
[junebuild/june repository](https://github.com/junebuild/june/security) so the
report stays confidential until a fix ships.

## For agents

This site answers agents directly, no human in the loop required: search it
with the `search_site` tool and read any page with `get_page`, over MCP at
[`/mcp`](/mcp) or over HTTP (`POST /api/search_site`, described by
[`/openapi.json`](/openapi.json)). [`/llms.txt`](/llms.txt) lists every page.
