---
"@junejs/server": patch
---

Content: a doc's title falls back to its first H1 when the frontmatter has no `title:`.

So plain Markdown with no front-matter still gets a real title (from its `# Heading`) instead
of defaulting to the slug — "point June at a docs/ folder, change nothing" now holds. A
frontmatter `title:` still wins; a doc with neither has an undefined title as before.
