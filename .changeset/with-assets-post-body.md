---
"@junejs/server": patch
---

`withAssets` only consults the `ASSETS` binding for GET/HEAD. It used to pass every request there first, and on workerd that consumes the request body, so on any deployed Workers app with assets a POST that fell through to the pipeline arrived with a used stream: `POST /mcp` answered `-32700 Parse error` and actions lost their input. The Bun dev host has no `ASSETS`, so this only showed up after deploy.
