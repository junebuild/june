---
title: About June
description: June is an open-source, MIT-licensed React framework for building agents into real apps, developed in the open on GitHub by June.build.
---
## What June is

June is a React framework for applications that serve two audiences at once:
people in a browser and AI agents over HTTP. One route definition renders HTML
for people and projects the same data as Markdown and JSON for agents. A server
action you define with `defineAction()` and give a `description` is also an MCP
tool at `/mcp` and a WebMCP tool in the browser, and, when its id is
URL-safe, a plain HTTP operation (`POST /api/<id>`) described by
`/openapi.json`.

An agent is a feature of a June app, not a separate runtime. The `agent/`
directory is the manifest: its tools are the app's own actions, exported into
`agent/tools/`, and its channels (Slack, Crisp, HTTP) are discovered from files.
Every turn is recorded step by step as it runs. Backed by a persistent store (a
SQLite file you mount, or Cloudflare Durable Objects on Workers), a crashed or
redeployed process resumes where it left off; the default in-memory store keeps
turns only while the process runs.

## Who builds it

June is developed in the open by June.build. The source code, issue tracker,
and release history live at
[github.com/junebuild/june](https://github.com/junebuild/june), and the
packages are published to npm under the
[`@junejs`](https://www.npmjs.com/org/junejs) scope. The canonical package
names are `@junejs/core`, `@junejs/server` and `@junejs/cli`, and a new app
starts with `npm create june`. Packages named `june` or scoped `@june/*` on npm
are unrelated projects.

## Licence and status

June is free software under the MIT licence. It is a `0.0.x` preview: APIs can
change between releases, and the [stability page](/docs/stability) lists which
surfaces are settled and which are still moving. Releases are cut from the
`main` branch and published by CI from a version tag.

## This site

june.build is itself a June app, deployed to Cloudflare Workers. Every page
here is also available as Markdown (append `.md`, or send
`Accept: text/markdown`), the site answers MCP at [`/mcp`](/mcp), and
[`/llms.txt`](/llms.txt) indexes everything for agents. See the
[contact page](/contact) to reach the project, and the
[privacy page](/privacy) for what this site does with your requests.
