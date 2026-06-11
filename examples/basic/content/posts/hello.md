---
title: Hello, June
date: 2026-06-11
description: The first post in the June Basic fixture.
tags: [june, rsc, agents]
---

# Hello, June

This markdown file is served three ways:

- **as HTML** in the `view` projection (rendered with `marked`),
- **as JSON** frontmatter + body via `.json`,
- **verbatim** as the `.md` projection — exactly these bytes, frontmatter and all.

That last one is the differentiator: an agent fetching `/posts/hello.md` reads
the authored source, not a lossy reconstruction.
