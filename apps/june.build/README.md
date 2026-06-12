# june.build — June's own site, built with June (the v0.1 dogfood)

Run: `bun packages/cli/src/june.ts dev apps/june.build` (from the repo root)
or `bun run dev` here. Tests: `bun test apps/june.build`.
Content changed? `bun run gen` regenerates `app/_content.ts`.

The site is its own dual-audience demo:

| humans | agents |
| --- | --- |
| `/` `/why` `/docs` `/blog` `/benchmarks` | `/why.md` `/benchmarks.json` (same routes, other projections) |
| | `/llms.txt` + MCP `/mcp`: `search_site`, `get_page` |

Static pages live in `app/content.ts`; posts and docs in `content/**/*.md`,
frozen to `app/_content.ts` by `june gen`/`june build` — ONE source feeds the
HTML views, the `.md` projections (authored file, verbatim), and both MCP
tools. The CJK post carries `lang: zh-Hant` frontmatter; the blog route puts
it on `<article lang>`, and the root layout's font stack ends in CJK faces.

Benchmark numbers render from `bench/results.json` (the named-run registry) —
never hand-copied. Deploy: `june deploy` (Workers).
