---
"@junejs/core": minor
---

OpenAPI connections work against real-world descriptions (#245).

**Behavior changes**

- **The OpenAPI document fetch no longer sends the connection's credentials
  to another host.** `headers` and `auth` go with the document request only
  when `baseUrl` is set and shares the document's origin. Before this change,
  they were sent to whatever host served the document; for GitHub's
  description, that meant sending the API token to `raw.githubusercontent.com`.
  The new `docAuth: true | false` option overrides the rule either way. If a
  protected document is fetched without credentials and answers 401 or 403,
  the connection fails with an error that names `baseUrl` and `docAuth`.
  **Check your connections:** one whose document requires auth and whose
  `baseUrl` is unset now needs `baseUrl` (or `docAuth: true`).
- **A non-2xx API response now throws**, with its status and the start of its
  body. Before, the error body was returned to the model as if it were data.
  An empty 2xx body now returns `null`, and a body that isn't JSON returns its
  text, where both used to throw a `SyntaxError`.

**Fixes and additions**

- **`$ref`s are resolved.** Local `#/components/…` refs in parameters and
  JSON request bodies are inlined, up to three levels deep, with a cycle
  guard. Before, every `$ref` parameter became an input property literally
  named `"undefined"`, and path placeholders were sent verbatim; 89% of the
  parameters in GitHub's description are `$ref`s. Parameters that can't be
  resolved are skipped, as are cookie parameters.
- **More of the spec is handled:**
  - Path-level parameters now apply to every operation in the path, and an
    operation's own parameter overrides one with the same name and location.
  - Non-method keys in a path item (`parameters`, `summary`, `servers`) are
    no longer turned into tools.
  - Header parameters are sent as headers instead of in the query string.
- **Tool ids are always valid tool names.** Characters outside
  `[A-Za-z0-9_-]` become `_`, ids are cut to 128 characters, and colliding ids
  get a numeric suffix. GitHub's `issues/list-for-repo` becomes
  `<name>__issues_list-for-repo`. Before, a single such id made the Claude API
  reject every request from the agent.
- **New `include` option.** It takes operationIds or tags, or a predicate that
  receives `{ operationId, method, path, tags }`, and limits which operations
  become tools. When a connection without `include` produces more than 100
  tools, June logs a warning.
