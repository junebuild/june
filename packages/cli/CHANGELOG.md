# @junejs/cli

## 0.2.1

### Patch Changes

- Updated dependencies [[`f2b1840`](https://github.com/junebuild/june/commit/f2b18400fdb5f2ff71dac794f20e5d4e751d4c42), [`eab7866`](https://github.com/junebuild/june/commit/eab7866854e8f1b6aa5bcf6dafad841dc7fc0da1)]:
  - @junejs/server@0.2.1
  - @junejs/core@0.2.1

## 0.2.0

### Minor Changes

- [#296](https://github.com/junebuild/june/pull/296) [`f2e0042`](https://github.com/junebuild/june/commit/f2e00429745c044d4fa31786f0d2fa2403e3d8d2) Thanks [@linyiru](https://github.com/linyiru)! - External subcommands: `june <verb>` that is not built in runs `june-<verb>` ([#295](https://github.com/junebuild/june/issues/295)).

  The git / cargo model, for clients that ship on their own — first, the operator inbox
  (`@junejs/inbox` behind `june inbox`, email RFC §9.3):

  - Looked up in `node_modules/.bin` from the working directory up (hoisted bins included), then
    on `PATH`. Built-in verbs always win; a verb must be a plain lowercase name, so `june ../x`
    never resolves.
  - The arguments are passed exactly as typed (June's parser never sees them), the terminal is
    inherited, the exit code is returned (128 + the signal when it is killed), and SIGTERM /
    SIGHUP are forwarded.
  - On Windows, a `.cmd` / `.bat` target runs through `cmd.exe` with cross-spawn's escaping: every
    argument quoted and its metacharacters `^`-escaped (twice for an npm shim). Verified on
    Windows 11 with 23 hostile arguments through both an npm `.cmd` shim and a bun `.exe` shim:
    all arrived literally, nothing was injected — where a plain `cmd.exe /c` split `a&b` and ran
    `b` as a command.
  - **The `june` launcher (`bin.mjs`) relays signals.** It waited on Bun with `spawnSync`, so a
    SIGTERM / SIGHUP sent to the `june` pid killed the Node wrapper and orphaned Bun — and
    whatever Bun ran: `june dev`, or an external command. It now runs Bun asynchronously,
    relays SIGTERM / SIGHUP, and mirrors the exit (128 + the signal). SIGINT is caught and
    relayed only without a terminal: Ctrl-C in a terminal already reaches the whole foreground
    group, and a second SIGINT would force what should be a graceful stop — verified through a
    PTY (exactly one SIGINT arrives; relaying always sent two).
  - A table of first-party external verbs feeds `june help` and an install hint when one is
    missing; it stays empty until `@junejs/inbox` publishes.
  - An unknown verb says where it looked.

- [#309](https://github.com/junebuild/june/pull/309) [`7736376`](https://github.com/junebuild/june/commit/77363765ea883c3f620fd5c0b713c5f871b822c3) Thanks [@linyiru](https://github.com/linyiru)! - `/mcp` and `/api/<id>` validate `Origin` and `Host`, and `june dev` binds `127.0.0.1` ([#308](https://github.com/junebuild/june/issues/308)).

  - **Origin (every host).** MCP 2026-07-28 requires servers to validate `Origin` against DNS rebinding and to answer an invalid one with 403. `mcpHandler` and `apiHandler` take an `OriginPolicy`. A request without an `Origin` passes, because CLIs, SDKs, and server-side connectors don't send one. A present `Origin` must be the request's own or listed in `agent.allowedOrigins`. Otherwise the answer is `403`: on `/mcp` a JSON-RPC error with no `id` (`-32000`), on `/api` `{ error: { code: "forbidden" } }`.
  - **CORS for listed origins.** A cross-origin browser app in `agent.allowedOrigins` gets its preflight answered (`POST`, the requested headers) and responses with `Access-Control-Allow-Origin`, `Access-Control-Allow-Credentials: true`, and `Vary: Origin`. Same-origin calls get no CORS headers.
  - **Checked before identity.** The pipeline applies the policy before `identity(request)`, so a refused call triggers no resolver I/O, and a throwing resolver can't turn the 403 into a 500. `mcpForbidden` and `apiForbidden` build the same 403 bodies for custom hosts. `GET /api` and every OpenAPI operation now list the `forbidden` / 403 response.
  - **Host (DNS rebinding).** After a rebind the attacker's page is same-origin, so only `Host` gives it away. When `agent.allowedHosts` is set, `Host` must be an IP literal or match an entry: `"example.com"`, or `".example.com"` for it and its subdomains. `june dev` always allows `localhost` and `.localhost`. The official conformance scenario `dns-rebinding-protection` now passes on both protocol eras.
  - **BREAKING (dev only): `june dev` binds `127.0.0.1`.** It used to listen on every interface. `june dev --host` restores that, and `--host <addr>` binds one address (the printed URL follows it). Behind a tunnel, add its domain to `agent.allowedHosts` (e.g. `".trycloudflare.com"`) to reach `/mcp` and `/api`. Production (`june start`, Workers) binds and routes as before.
  - Malformed `allowedOrigins` or `allowedHosts` entries fail when the config resolves. `originRejection` and `OriginPolicy` are exported from `@junejs/core/mcp` for custom hosts.

### Patch Changes

- [#235](https://github.com/junebuild/june/pull/235) [`862a969`](https://github.com/junebuild/june/commit/862a9693cc3ab00cfb5c08e6bc07542590b58349) Thanks [@linyiru](https://github.com/linyiru)! - Actions are now also plain HTTP: `POST /api/<id>` + `/openapi.json`.

  - Every rich `defineAction` (one with a description, the same set `/mcp` lists)
    is also `POST /api/<id>`: the JSON body is the input and the JSON response is
    the result. It goes through the same `invokeAction`, with the same
    `createPipeline({ identity })` principal as `/mcp`, so `requiresPrincipal`
    and schema validation hold on this surface too. Only an action's canonical
    path (`/api/` + `encodeURIComponent(id)`) is claimed, and every other
    `/api/*` path still falls through to the app's routes.
  - Errors have one shape, `{ error: { code, message, hint? } }`, classified the
    same way as `/mcp` (via `actionDispatchCode`): `invalid_input` (400) and
    `unauthorized` (401) are invokeAction's own refusals; anything the action
    throws — including a nested dispatch refusal it lets escape — is
    `execution_error` (500, message only, never a stack). Transport codes:
    `invalid_json` (400), `not_found` (404), `method_not_allowed` (405, with
    `Allow: POST`), `unsupported_media_type` (415). A JSON `Content-Type` is
    required (an RFC 9110 media type whose type/subtype is `application/json` or a
    `+json` type), so a cross-site browser request is always CORS-preflighted and
    can't reach an action with a simple form post.
  - `GET /openapi.json` returns an OpenAPI 3.1 document generated from the
    registry: one POST operation per action, with `operationId` = the action id,
    `summary`/`description`, the input schema as a required request body (send
    `{}` when a tool takes no input), and typed 200 and error responses (a shared
    `Error` schema). An action's MCP `annotations` appear as `x-mcp-annotations`.
  - The HTTP API is one more `agentServices()` entry, so it is advertised
    everywhere the MCP server is: the homepage `Link` header
    (`rel="service-desc"`), the RFC 9727 api-catalog (an `item` with its
    `service-desc`), the ARD / AI Catalog (an `api` entry), the generated
    SKILL.md ("Act (HTTP)"), an llms.txt "HTTP API" section, the actionable 404,
    and `june info`. Its media type is `application/json` everywhere, from one
    constant (`OPENAPI_MEDIA_TYPE`): IANA registers no OpenAPI media type. A
    static build projects it out with MCP — no server, nothing advertised.
  - New `agent.api` flag: on by default, off with `agent.enabled: false`. New
    subpath: `@junejs/core/api` (`apiHandler`, `apiActionId`, `apiActionPath`,
    `isRoutableActionId`, `isJsonContentType`, `OPENAPI_MEDIA_TYPE`,
    `openApiDocument`). An action id that cannot be a URL path segment (`""`,
    `"."`, `".."`, or one that can't be encoded at all) stays valid for
    `defineAction` and `/mcp` but is left off this surface, with a one-time
    warning.

- [#140](https://github.com/junebuild/june/pull/140) [`c4b2a28`](https://github.com/junebuild/june/commit/c4b2a289b409c65a2827c42c6c4abea1c43ea828) Thanks [@linyiru](https://github.com/linyiru)! - Agent directory compile — the agent/ convention mounts on the edge ([#139](https://github.com/junebuild/june/issues/139)).

  `discoverAgent` is fs-based and native-only, so every edge consumer hand-assembled what the directory already declares: statically imported tools in a hand-maintained registry, instructions bundled via the wrangler `[[rules]]` Text hack (plus a mirroring vitest md-loader and `readFileSync` in Node scripts — three loaders kept honest only by discipline), manually wired `channelInstructions`, and no skills at all — nothing on the edge synthesized `read_skill`, so authored `skills/*.md` were inert. `june gen` now compiles the directory into `agent/_agent.gen.ts`: static imports for code (tools/channels/connections), prose inlined as string literals (instructions, channel overlays, skills — parsed at init by core's `parseSkill`, so a parser improvement never requires regeneration). Plain erasable TypeScript: bundles under wrangler/Rolldown, imports under bun test and Node type stripping, no loader plugins anywhere. `june gen --check` (and plain `git diff --exit-code` after `june gen`) is the CI staleness gate; `.ts` import extensions are kept when the consumer's tsconfig enables `allowImportingTsExtensions` (Node type-stripping consumers), dropped otherwise.

  One assembly path, two targets — `@junejs/core/agent-config` gains the shared entry points both runtimes go through, so native discovery and the compiled module cannot drift. `AgentModule` is the raw directory shape (channels stay unresolved factories; connections stay definitions — both resolve where the agent actually runs). `assembleAgent(module, env)` is the native side: resolves channel factories, wires connections (`connectAll`), hands everything to `defineAgent` — `discoverAgent` is now a thin fs scan feeding it. `assembleDurable(module)` is the DO side: adapted tools + a synthesized `read_skill`, the system prompt pre-composed with the skill index (`buildSystemPrompt`), channel factories passed through untouched for the DO to resolve with its own env — spread it into `new AgentDurableObject(ctx, { ...assembleDurable(agentModule), model, env, services })`. Skills therefore mount on the Durable Object target for the first time.

  The directory convention grows two pieces the first real consumer already reached for: `channels/<source>.md` is discovered as that channel's `channelInstructions` overlay (native and compiled alike), and skill frontmatter supports `when-to-use` (hyphenated keys now parse; `Skill.whenToUse` rides the prompt's skill index line so the model can decide whether to load a body without spending a tool call). `parseSkill` moved to `@junejs/core/agent-config` — pure, shared by discovery, the compiled module, and tests. `_`-prefixed files under an agent directory are now private by convention (never scanned), which is also what keeps `_agent.gen.ts` itself out of the scan. `examples/agent-edge` is restructured to the compiled pattern: the definition lives in `agent/`, the worker keeps only the DO shell (model + env wiring) and the routed surfaces.

  Follow-up (tracked in [#139](https://github.com/junebuild/june/issues/139)): `june build` sets `WorkerManifest.agentName` and emits the DO class + wrangler `durable_objects`/`migrations` bindings so a June-native app's edge auto-mounts with zero hand-written worker; lazy connection wiring in the DO.

- Updated dependencies [[`fea4078`](https://github.com/junebuild/june/commit/fea407877de98adda39c2f277d45157ea9a8d6f0), [`862a969`](https://github.com/junebuild/june/commit/862a9693cc3ab00cfb5c08e6bc07542590b58349), [`7d1d670`](https://github.com/junebuild/june/commit/7d1d670734f3e4f478e3936670267616f253bc8f), [`32b3e9b`](https://github.com/junebuild/june/commit/32b3e9bb08b6af4d2f247c5cd5291afc567748cc), [`cde48a2`](https://github.com/junebuild/june/commit/cde48a28d8a532b2d5d549d569894dff28caba39), [`c4b2a28`](https://github.com/junebuild/june/commit/c4b2a289b409c65a2827c42c6c4abea1c43ea828), [`cc5905e`](https://github.com/junebuild/june/commit/cc5905ebd7b1498250ed1fc28223121072c059e7), [`0fff693`](https://github.com/junebuild/june/commit/0fff693466caa15098c985fed9883626f3a4970a), [`80576b2`](https://github.com/junebuild/june/commit/80576b274d7cb1be57875476b77b7b416d974d96), [`4a491da`](https://github.com/junebuild/june/commit/4a491da1b57a990b9ef93e66abab9ecac6ed3ba7), [`727c02d`](https://github.com/junebuild/june/commit/727c02ddbb2f1b9eb1a95907752345a93bad751a), [`eac1daa`](https://github.com/junebuild/june/commit/eac1daa276c2f2f94ca1d98f2306a83a5a88563f), [`502d895`](https://github.com/junebuild/june/commit/502d89555c76cb11254fac2df09cfdb22b0384d3), [`cc70d23`](https://github.com/junebuild/june/commit/cc70d236c6824f4edc207c87ba094b299cdbeb15), [`7a8fff4`](https://github.com/junebuild/june/commit/7a8fff4ee78be4bd576824daca8d4b4acedbdc05), [`d062d48`](https://github.com/junebuild/june/commit/d062d48c1fe675fe0a18d1fad3eb143c1a270959), [`b46bc2c`](https://github.com/junebuild/june/commit/b46bc2c4a50cd3d213f9ed9da4bc079f1287f434), [`f2ed6ba`](https://github.com/junebuild/june/commit/f2ed6ba41bac8ac5dbab86a701385d6aca80b226), [`3c6e981`](https://github.com/junebuild/june/commit/3c6e98100d109f996f36cb876a3399e088da4d9a), [`4847104`](https://github.com/junebuild/june/commit/4847104007432e1916618529c3465cbd73c59982), [`8255355`](https://github.com/junebuild/june/commit/825535570f716a81445b490d9b93e98671527c70), [`7272fa5`](https://github.com/junebuild/june/commit/7272fa59a9a692753a5c349d1537ae0064aecd4b), [`7c2fb9d`](https://github.com/junebuild/june/commit/7c2fb9d02ae5a89f511676b72647e0e0423ce17c), [`410928a`](https://github.com/junebuild/june/commit/410928a389db7c2e07434ee03f02b94914202d0f), [`aaceb01`](https://github.com/junebuild/june/commit/aaceb01daec1fb8553e1f2b03627a8d54e9125f8), [`8f26396`](https://github.com/junebuild/june/commit/8f2639650be7a6c5baba8f2042d9173c4115d829), [`04909db`](https://github.com/junebuild/june/commit/04909dbf82dc45e3f003026d8ca8895e9adb8108), [`500687e`](https://github.com/junebuild/june/commit/500687ebfec102e8da94610edcc1c525bdf4f2e5), [`d323e45`](https://github.com/junebuild/june/commit/d323e458f5889b9179b137425af2ae8718b24d6e), [`0703648`](https://github.com/junebuild/june/commit/07036488b678e7cc6b17434d916908320a8fd7f8), [`19aa6e3`](https://github.com/junebuild/june/commit/19aa6e38a2a0e2cc42e2173ecdb4db94feb9490b), [`b1c31e4`](https://github.com/junebuild/june/commit/b1c31e4781a55013b266e709988331c256c90f11), [`ffdb05c`](https://github.com/junebuild/june/commit/ffdb05c83400632cde32abd59b86bb8186a48b6a), [`b20cc77`](https://github.com/junebuild/june/commit/b20cc7726736cfc48506e7a5d06ab7eddba9f466), [`ddb8a0c`](https://github.com/junebuild/june/commit/ddb8a0cb1b5b11483c920d3cad5f9d46a1f66a3a), [`fba01b9`](https://github.com/junebuild/june/commit/fba01b9060774db087594a7e825e8c4e2ff4a73f), [`09d9901`](https://github.com/junebuild/june/commit/09d99010df4865fed38cfa64c79efeccb200c0b0), [`c12b786`](https://github.com/junebuild/june/commit/c12b78696152545bd53ce52dec9a00254e9cd3a8), [`044ff2f`](https://github.com/junebuild/june/commit/044ff2fcec8d507221d7a7d53f37eb635d1f7750), [`a10a457`](https://github.com/junebuild/june/commit/a10a457b8dddebbe76a15a9961da28d264dfb76b), [`0ccd10a`](https://github.com/junebuild/june/commit/0ccd10a8b40422eb164cfd4ba5c9e9bd64ba07b1), [`6048baa`](https://github.com/junebuild/june/commit/6048baa65d27c0e705b38516af15579970300733), [`48de649`](https://github.com/junebuild/june/commit/48de649acc7d91afa803e8d4241130ec38d58b70), [`fa15d1d`](https://github.com/junebuild/june/commit/fa15d1d08a04764647963d6ff9f42c3a75a6d900), [`e84546c`](https://github.com/junebuild/june/commit/e84546c8e14b87a8cee4a004d67764bc6b17c806), [`0e676ac`](https://github.com/junebuild/june/commit/0e676ac478e5aa016408c360a3e221c01ca502a8), [`345fbad`](https://github.com/junebuild/june/commit/345fbad23a6cc8d11b822cffc014fe0903b4961d), [`7736376`](https://github.com/junebuild/june/commit/77363765ea883c3f620fd5c0b713c5f871b822c3), [`18cc523`](https://github.com/junebuild/june/commit/18cc523dabecf56ef510e64ce0b94edf02ce9e02), [`e396979`](https://github.com/junebuild/june/commit/e3969795a2cfb2d085f3f32b575507d44b371262), [`403d543`](https://github.com/junebuild/june/commit/403d54328efa9a2813c1f78af271d851f74becbb), [`128d733`](https://github.com/junebuild/june/commit/128d733a21465910bbf97d7e918deee15e6e920a), [`fdd13e9`](https://github.com/junebuild/june/commit/fdd13e91584af5872175bad4af582b30e3e04f80), [`68e7adc`](https://github.com/junebuild/june/commit/68e7adc9f5912907e042bacb61296eac19ef3a79), [`b418d53`](https://github.com/junebuild/june/commit/b418d537ded688ddcae1098b1ae39c821650f813), [`3ad841c`](https://github.com/junebuild/june/commit/3ad841ce43daa5a5fb6af79927e840e117a6c979), [`4018c25`](https://github.com/junebuild/june/commit/4018c2569f96dc267e15520e20063693289145b7), [`10b0119`](https://github.com/junebuild/june/commit/10b01190b98521890b36e599b1953bfca635625e), [`7467f33`](https://github.com/junebuild/june/commit/7467f331b5940f1b5720c7adb5688833542c0615), [`88a2e61`](https://github.com/junebuild/june/commit/88a2e618ee7bb31773a9615788347e4f9b632396), [`0a47816`](https://github.com/junebuild/june/commit/0a4781607d6434873bfee9cab9989507ba0271bc), [`6a915e4`](https://github.com/junebuild/june/commit/6a915e4f3e2c07b8b35b086e1033836dae6696b3), [`5703ce1`](https://github.com/junebuild/june/commit/5703ce16b7aa3662a70ca95a80139abb11bc4c19), [`c893a9a`](https://github.com/junebuild/june/commit/c893a9ac19f6d90af5d37345039559b753dc0f68), [`4e16e7c`](https://github.com/junebuild/june/commit/4e16e7cbd2e5fb5ca22bb2fb41916f75ecaf30f4), [`310b707`](https://github.com/junebuild/june/commit/310b7070fd1a72da8e171b9171e500e77a132c3b), [`29504fe`](https://github.com/junebuild/june/commit/29504fe04c286b76b0d9727b1d222910ad5a9c82), [`acb081e`](https://github.com/junebuild/june/commit/acb081e3fabf48431dbf8b11afc9e027b9e41301), [`981aa5c`](https://github.com/junebuild/june/commit/981aa5c54aeaf557fcdd4efe63300a2f78aaa306), [`c54a6f0`](https://github.com/junebuild/june/commit/c54a6f08547413c9a020b673b7181ea9fb496b01), [`6e31981`](https://github.com/junebuild/june/commit/6e319810e5888875434656f282e57818ec895229), [`7aee078`](https://github.com/junebuild/june/commit/7aee0786f2a28f78e20afe1f56b7d3991514a3b3), [`932e46f`](https://github.com/junebuild/june/commit/932e46f9d54e67f88b386a33bebf4ed82e56ff08), [`8d0544f`](https://github.com/junebuild/june/commit/8d0544f8df00c8d5cb0231271300eced730d091a), [`f797398`](https://github.com/junebuild/june/commit/f7973988af18f25ce5e3c27637c526949512b44f), [`6f3e89f`](https://github.com/junebuild/june/commit/6f3e89facf76df91ea10c02fe2c46a822d4af86d), [`784388b`](https://github.com/junebuild/june/commit/784388b6b197e8dc23d8d0f7195581fc227a51af), [`771772f`](https://github.com/junebuild/june/commit/771772f4f790a4fc48d4782ac5a7bff9e99f9943), [`d1c9f23`](https://github.com/junebuild/june/commit/d1c9f235e887c0253a805c442e4b1a9bf5c3cdc5), [`370849c`](https://github.com/junebuild/june/commit/370849cfa22050a8653895d5949b085646706a35), [`271f843`](https://github.com/junebuild/june/commit/271f843009defa9718049cdff5687c5f0ff454a0), [`a5b49ed`](https://github.com/junebuild/june/commit/a5b49eda506c1796145bd4e1834dcc3c2c837b23), [`7c2c820`](https://github.com/junebuild/june/commit/7c2c820689370a71c9f114e6aac520e4e3030bcf), [`8128c20`](https://github.com/junebuild/june/commit/8128c2059c8085851e4ee0793b4ca4ef4a1390cd), [`38abeae`](https://github.com/junebuild/june/commit/38abeae8ab444ac66e8cdbc279aa602f94858bef), [`b7d4e55`](https://github.com/junebuild/june/commit/b7d4e5529be316c61e32ff363046b2c57480dfdd), [`7a6c6e6`](https://github.com/junebuild/june/commit/7a6c6e6887986f027b2bde5e595e1de98b7442d5), [`2b9eefe`](https://github.com/junebuild/june/commit/2b9eefec6c84044385e511a9637b4b98d5b9df50), [`ea29ca5`](https://github.com/junebuild/june/commit/ea29ca50916d524e47ce63d261719ba0366ae007), [`db3c835`](https://github.com/junebuild/june/commit/db3c83556b730d9b2184e89cd025296c0e42ef55), [`3a21f13`](https://github.com/junebuild/june/commit/3a21f13c0f52be58b5bf087d22e685be47f1a1c5), [`b414b0d`](https://github.com/junebuild/june/commit/b414b0d2fdca032f7d6e4e6ea1a3d1eb4334a306), [`17988f3`](https://github.com/junebuild/june/commit/17988f3f6ae2349f0f6c9589b2f8ff68c2c380cd), [`2e4cc43`](https://github.com/junebuild/june/commit/2e4cc43cabe64bc569c9f6039ffc6f68765c328f), [`f08d622`](https://github.com/junebuild/june/commit/f08d622d24f21f2529a9cd784318070122a17d54), [`1ebd63b`](https://github.com/junebuild/june/commit/1ebd63b6ebe3b9b1c4a8722a52ae1f0daff644d2), [`595772c`](https://github.com/junebuild/june/commit/595772cc4e1075677f490796981cf737018687f2), [`51c52b5`](https://github.com/junebuild/june/commit/51c52b514df482ea551872dccf2798db1ad5d407)]:
  - @junejs/core@0.2.0
  - @junejs/server@1.0.0

## 0.1.0-dev.5

### Minor Changes

- [#309](https://github.com/junebuild/june/pull/309) [`7736376`](https://github.com/junebuild/june/commit/77363765ea883c3f620fd5c0b713c5f871b822c3) Thanks [@linyiru](https://github.com/linyiru)! - `/mcp` and `/api/<id>` validate `Origin` and `Host`, and `june dev` binds `127.0.0.1` ([#308](https://github.com/junebuild/june/issues/308)).

  - **Origin (every host).** MCP 2026-07-28 requires servers to validate `Origin` against DNS rebinding and to answer an invalid one with 403. `mcpHandler` and `apiHandler` take an `OriginPolicy`. A request without an `Origin` passes, because CLIs, SDKs, and server-side connectors don't send one. A present `Origin` must be the request's own or listed in `agent.allowedOrigins`. Otherwise the answer is `403`: on `/mcp` a JSON-RPC error with no `id` (`-32000`), on `/api` `{ error: { code: "forbidden" } }`.
  - **CORS for listed origins.** A cross-origin browser app in `agent.allowedOrigins` gets its preflight answered (`POST`, the requested headers) and responses with `Access-Control-Allow-Origin`, `Access-Control-Allow-Credentials: true`, and `Vary: Origin`. Same-origin calls get no CORS headers.
  - **Checked before identity.** The pipeline applies the policy before `identity(request)`, so a refused call triggers no resolver I/O, and a throwing resolver can't turn the 403 into a 500. `mcpForbidden` and `apiForbidden` build the same 403 bodies for custom hosts. `GET /api` and every OpenAPI operation now list the `forbidden` / 403 response.
  - **Host (DNS rebinding).** After a rebind the attacker's page is same-origin, so only `Host` gives it away. When `agent.allowedHosts` is set, `Host` must be an IP literal or match an entry: `"example.com"`, or `".example.com"` for it and its subdomains. `june dev` always allows `localhost` and `.localhost`. The official conformance scenario `dns-rebinding-protection` now passes on both protocol eras.
  - **BREAKING (dev only): `june dev` binds `127.0.0.1`.** It used to listen on every interface. `june dev --host` restores that, and `--host <addr>` binds one address (the printed URL follows it). Behind a tunnel, add its domain to `agent.allowedHosts` (e.g. `".trycloudflare.com"`) to reach `/mcp` and `/api`. Production (`june start`, Workers) binds and routes as before.
  - Malformed `allowedOrigins` or `allowedHosts` entries fail when the config resolves. `originRejection` and `OriginPolicy` are exported from `@junejs/core/mcp` for custom hosts.

### Patch Changes

- Updated dependencies [[`7736376`](https://github.com/junebuild/june/commit/77363765ea883c3f620fd5c0b713c5f871b822c3), [`10b0119`](https://github.com/junebuild/june/commit/10b01190b98521890b36e599b1953bfca635625e), [`29504fe`](https://github.com/junebuild/june/commit/29504fe04c286b76b0d9727b1d222910ad5a9c82)]:
  - @junejs/core@0.2.0-dev.65
  - @junejs/server@1.0.0-dev.45

## 0.1.0-dev.4

### Minor Changes

- [#296](https://github.com/junebuild/june/pull/296) [`f2e0042`](https://github.com/junebuild/june/commit/f2e00429745c044d4fa31786f0d2fa2403e3d8d2) Thanks [@linyiru](https://github.com/linyiru)! - External subcommands: `june <verb>` that is not built in runs `june-<verb>` ([#295](https://github.com/junebuild/june/issues/295)).

  The git / cargo model, for clients that ship on their own — first, the operator inbox
  (`@junejs/inbox` behind `june inbox`, email RFC §9.3):

  - Looked up in `node_modules/.bin` from the working directory up (hoisted bins included), then
    on `PATH`. Built-in verbs always win; a verb must be a plain lowercase name, so `june ../x`
    never resolves.
  - The arguments are passed exactly as typed (June's parser never sees them), the terminal is
    inherited, the exit code is returned (128 + the signal when it is killed), and SIGTERM /
    SIGHUP are forwarded.
  - On Windows, a `.cmd` / `.bat` target runs through `cmd.exe` with cross-spawn's escaping: every
    argument quoted and its metacharacters `^`-escaped (twice for an npm shim). Verified on
    Windows 11 with 23 hostile arguments through both an npm `.cmd` shim and a bun `.exe` shim:
    all arrived literally, nothing was injected — where a plain `cmd.exe /c` split `a&b` and ran
    `b` as a command.
  - **The `june` launcher (`bin.mjs`) relays signals.** It waited on Bun with `spawnSync`, so a
    SIGTERM / SIGHUP sent to the `june` pid killed the Node wrapper and orphaned Bun — and
    whatever Bun ran: `june dev`, or an external command. It now runs Bun asynchronously,
    relays SIGTERM / SIGHUP, and mirrors the exit (128 + the signal). SIGINT is caught and
    relayed only without a terminal: Ctrl-C in a terminal already reaches the whole foreground
    group, and a second SIGINT would force what should be a graceful stop — verified through a
    PTY (exactly one SIGINT arrives; relaying always sent two).
  - A table of first-party external verbs feeds `june help` and an install hint when one is
    missing; it stays empty until `@junejs/inbox` publishes.
  - An unknown verb says where it looked.

### Patch Changes

- Updated dependencies [[`981aa5c`](https://github.com/junebuild/june/commit/981aa5c54aeaf557fcdd4efe63300a2f78aaa306)]:
  - @junejs/core@0.2.0-dev.62
  - @junejs/server@1.0.0-dev.41

## 0.0.52-dev.3

### Patch Changes

- [#235](https://github.com/junebuild/june/pull/235) [`862a969`](https://github.com/junebuild/june/commit/862a9693cc3ab00cfb5c08e6bc07542590b58349) Thanks [@linyiru](https://github.com/linyiru)! - Actions are now also plain HTTP: `POST /api/<id>` + `/openapi.json`.

  - Every rich `defineAction` (one with a description, the same set `/mcp` lists)
    is also `POST /api/<id>`: the JSON body is the input and the JSON response is
    the result. It goes through the same `invokeAction`, with the same
    `createPipeline({ identity })` principal as `/mcp`, so `requiresPrincipal`
    and schema validation hold on this surface too. Only an action's canonical
    path (`/api/` + `encodeURIComponent(id)`) is claimed, and every other
    `/api/*` path still falls through to the app's routes.
  - Errors have one shape, `{ error: { code, message, hint? } }`, classified the
    same way as `/mcp` (via `actionDispatchCode`): `invalid_input` (400) and
    `unauthorized` (401) are invokeAction's own refusals; anything the action
    throws — including a nested dispatch refusal it lets escape — is
    `execution_error` (500, message only, never a stack). Transport codes:
    `invalid_json` (400), `not_found` (404), `method_not_allowed` (405, with
    `Allow: POST`), `unsupported_media_type` (415). A JSON `Content-Type` is
    required (an RFC 9110 media type whose type/subtype is `application/json` or a
    `+json` type), so a cross-site browser request is always CORS-preflighted and
    can't reach an action with a simple form post.
  - `GET /openapi.json` returns an OpenAPI 3.1 document generated from the
    registry: one POST operation per action, with `operationId` = the action id,
    `summary`/`description`, the input schema as a required request body (send
    `{}` when a tool takes no input), and typed 200 and error responses (a shared
    `Error` schema). An action's MCP `annotations` appear as `x-mcp-annotations`.
  - The HTTP API is one more `agentServices()` entry, so it is advertised
    everywhere the MCP server is: the homepage `Link` header
    (`rel="service-desc"`), the RFC 9727 api-catalog (an `item` with its
    `service-desc`), the ARD / AI Catalog (an `api` entry), the generated
    SKILL.md ("Act (HTTP)"), an llms.txt "HTTP API" section, the actionable 404,
    and `june info`. Its media type is `application/json` everywhere, from one
    constant (`OPENAPI_MEDIA_TYPE`): IANA registers no OpenAPI media type. A
    static build projects it out with MCP — no server, nothing advertised.
  - New `agent.api` flag: on by default, off with `agent.enabled: false`. New
    subpath: `@junejs/core/api` (`apiHandler`, `apiActionId`, `apiActionPath`,
    `isRoutableActionId`, `isJsonContentType`, `OPENAPI_MEDIA_TYPE`,
    `openApiDocument`). An action id that cannot be a URL path segment (`""`,
    `"."`, `".."`, or one that can't be encoded at all) stays valid for
    `defineAction` and `/mcp` but is left off this surface, with a one-time
    warning.

- Updated dependencies [[`862a969`](https://github.com/junebuild/june/commit/862a9693cc3ab00cfb5c08e6bc07542590b58349), [`cde48a2`](https://github.com/junebuild/june/commit/cde48a28d8a532b2d5d549d569894dff28caba39), [`eac1daa`](https://github.com/junebuild/june/commit/eac1daa276c2f2f94ca1d98f2306a83a5a88563f), [`18cc523`](https://github.com/junebuild/june/commit/18cc523dabecf56ef510e64ce0b94edf02ce9e02), [`c54a6f0`](https://github.com/junebuild/june/commit/c54a6f08547413c9a020b673b7181ea9fb496b01)]:
  - @junejs/core@0.2.0-dev.51
  - @junejs/server@1.0.0-dev.31

## 0.0.52-dev.2

### Patch Changes

- [#140](https://github.com/junebuild/june/pull/140) [`c4b2a28`](https://github.com/junebuild/june/commit/c4b2a289b409c65a2827c42c6c4abea1c43ea828) Thanks [@linyiru](https://github.com/linyiru)! - Agent directory compile — the agent/ convention mounts on the edge ([#139](https://github.com/junebuild/june/issues/139)).

  `discoverAgent` is fs-based and native-only, so every edge consumer hand-assembled what the directory already declares: statically imported tools in a hand-maintained registry, instructions bundled via the wrangler `[[rules]]` Text hack (plus a mirroring vitest md-loader and `readFileSync` in Node scripts — three loaders kept honest only by discipline), manually wired `channelInstructions`, and no skills at all — nothing on the edge synthesized `read_skill`, so authored `skills/*.md` were inert. `june gen` now compiles the directory into `agent/_agent.gen.ts`: static imports for code (tools/channels/connections), prose inlined as string literals (instructions, channel overlays, skills — parsed at init by core's `parseSkill`, so a parser improvement never requires regeneration). Plain erasable TypeScript: bundles under wrangler/Rolldown, imports under bun test and Node type stripping, no loader plugins anywhere. `june gen --check` (and plain `git diff --exit-code` after `june gen`) is the CI staleness gate; `.ts` import extensions are kept when the consumer's tsconfig enables `allowImportingTsExtensions` (Node type-stripping consumers), dropped otherwise.

  One assembly path, two targets — `@junejs/core/agent-config` gains the shared entry points both runtimes go through, so native discovery and the compiled module cannot drift. `AgentModule` is the raw directory shape (channels stay unresolved factories; connections stay definitions — both resolve where the agent actually runs). `assembleAgent(module, env)` is the native side: resolves channel factories, wires connections (`connectAll`), hands everything to `defineAgent` — `discoverAgent` is now a thin fs scan feeding it. `assembleDurable(module)` is the DO side: adapted tools + a synthesized `read_skill`, the system prompt pre-composed with the skill index (`buildSystemPrompt`), channel factories passed through untouched for the DO to resolve with its own env — spread it into `new AgentDurableObject(ctx, { ...assembleDurable(agentModule), model, env, services })`. Skills therefore mount on the Durable Object target for the first time.

  The directory convention grows two pieces the first real consumer already reached for: `channels/<source>.md` is discovered as that channel's `channelInstructions` overlay (native and compiled alike), and skill frontmatter supports `when-to-use` (hyphenated keys now parse; `Skill.whenToUse` rides the prompt's skill index line so the model can decide whether to load a body without spending a tool call). `parseSkill` moved to `@junejs/core/agent-config` — pure, shared by discovery, the compiled module, and tests. `_`-prefixed files under an agent directory are now private by convention (never scanned), which is also what keeps `_agent.gen.ts` itself out of the scan. `examples/agent-edge` is restructured to the compiled pattern: the definition lives in `agent/`, the worker keeps only the DO shell (model + env wiring) and the routed surfaces.

  Follow-up (tracked in [#139](https://github.com/junebuild/june/issues/139)): `june build` sets `WorkerManifest.agentName` and emits the DO class + wrangler `durable_objects`/`migrations` bindings so a June-native app's edge auto-mounts with zero hand-written worker; lazy connection wiring in the DO.

- Updated dependencies [[`c4b2a28`](https://github.com/junebuild/june/commit/c4b2a289b409c65a2827c42c6c4abea1c43ea828)]:
  - @junejs/core@0.2.0-dev.33
  - @junejs/server@1.0.0-dev.15

## 0.0.52-dev.1

### Patch Changes

- Updated dependencies [[`fea4078`](https://github.com/junebuild/june/commit/fea407877de98adda39c2f277d45157ea9a8d6f0)]:
  - @junejs/core@0.2.0-dev.26
  - @junejs/server@1.0.0-dev.10

## 0.0.52-dev.0

### Patch Changes

- Updated dependencies []:
  - @junejs/core@0.1.1-dev.0
  - @junejs/server@0.1.2-dev.0

## 0.0.51

### Patch Changes

- [`b3b6122`](https://github.com/junebuild/june/commit/b3b6122d68fe0ac68d8cb753bae07293b602eafd) Thanks [@linyiru](https://github.com/linyiru)! - Ship compiled JS + `.d.ts` from the remaining packages so plain Node can consume
  them too.

  Completes the dual-export rollout started with `@junejs/core`. `@junejs/db`,
  `@junejs/juno`, `@junejs/i18n`, `@junejs/og`, and `@junejs/cli` now build to
  `dist/` (ESM JS + `.d.ts`) via tsdown and use **dual-condition exports**:
  `source`/`bun` still serve `src/*.ts` (the zero-build inner loop, Bun, opt-in
  bundlers), while `default`/`types` serve built JS + declarations for Node and
  external `tsc`. Notes per package:

  - `@junejs/og` keeps its per-runtime backend selection — `workerd`/`edge-light`/
    `default` each map to the right built entry; the OG renderers (`workers-og`,
    `@vercel/og`) stay external so their WASM is never bundled.
  - `@junejs/cli` builds only its `.` export (`run(argv)`); the `june` bin still
    runs `src/june.ts` raw under Bun.

  `ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING` is now closed across the whole
  workspace.

- Updated dependencies [[`5bda3b8`](https://github.com/junebuild/june/commit/5bda3b86984c220549e12c9fadc719dece95490f), [`a20cc98`](https://github.com/junebuild/june/commit/a20cc98abdad5d4ccee8ff7d6fd01ee01895bee3), [`f1bdcc6`](https://github.com/junebuild/june/commit/f1bdcc66e4db1e91f5a2e58b15bcd8bd5d8bf45d), [`9950e93`](https://github.com/junebuild/june/commit/9950e93ec899bc117682d2c73169176bb0f195fa), [`e70960d`](https://github.com/junebuild/june/commit/e70960d19ac1f70da54e22f666891ce5b1c4ba77), [`af8c0a7`](https://github.com/junebuild/june/commit/af8c0a7b34f90b113b54d9230806612f5d7d89e3), [`84d4ade`](https://github.com/junebuild/june/commit/84d4adec4760fe40cfea0844dda6c53ad9978da2), [`c87f4eb`](https://github.com/junebuild/june/commit/c87f4eb59e6001fec85a76851305f253f6f836e7), [`d5e5563`](https://github.com/junebuild/june/commit/d5e55631f488fb73cc804588e539706e8451017e), [`56e0dfd`](https://github.com/junebuild/june/commit/56e0dfd96c16e4b9e8e58b9069e62460f3b05090), [`e8eddb5`](https://github.com/junebuild/june/commit/e8eddb53d5111c7d310c2af1f3efd58861780ee4), [`7680f6e`](https://github.com/junebuild/june/commit/7680f6eaed272245393a7c214b174c5743d90db8), [`21791e3`](https://github.com/junebuild/june/commit/21791e3e27f58c59d9544158817a42ec5cd719cc), [`9dc99d5`](https://github.com/junebuild/june/commit/9dc99d5bd0851bdd1aa261311ce108e697b85b3f), [`9a5f0fc`](https://github.com/junebuild/june/commit/9a5f0fcb5dd051526c27fb271ee755f16fbfee94)]:
  - @junejs/core@0.1.0
  - @junejs/server@0.1.0

## 0.0.51-dev.1

### Patch Changes

- [`b3b6122`](https://github.com/junebuild/june/commit/b3b6122d68fe0ac68d8cb753bae07293b602eafd) Thanks [@linyiru](https://github.com/linyiru)! - Ship compiled JS + `.d.ts` from the remaining packages so plain Node can consume
  them too.

  Completes the dual-export rollout started with `@junejs/core`. `@junejs/db`,
  `@junejs/juno`, `@junejs/i18n`, `@junejs/og`, and `@junejs/cli` now build to
  `dist/` (ESM JS + `.d.ts`) via tsdown and use **dual-condition exports**:
  `source`/`bun` still serve `src/*.ts` (the zero-build inner loop, Bun, opt-in
  bundlers), while `default`/`types` serve built JS + declarations for Node and
  external `tsc`. Notes per package:

  - `@junejs/og` keeps its per-runtime backend selection — `workerd`/`edge-light`/
    `default` each map to the right built entry; the OG renderers (`workers-og`,
    `@vercel/og`) stay external so their WASM is never bundled.
  - `@junejs/cli` builds only its `.` export (`run(argv)`); the `june` bin still
    runs `src/june.ts` raw under Bun.

  `ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING` is now closed across the whole
  workspace.

- Updated dependencies [[`21791e3`](https://github.com/junebuild/june/commit/21791e3e27f58c59d9544158817a42ec5cd719cc)]:
  - @junejs/core@0.1.0-dev.4
  - @junejs/server@0.1.0-dev.5

## 0.0.51-dev.0

### Patch Changes

- Updated dependencies [[`a20cc98`](https://github.com/junebuild/june/commit/a20cc98abdad5d4ccee8ff7d6fd01ee01895bee3), [`f1bdcc6`](https://github.com/junebuild/june/commit/f1bdcc66e4db1e91f5a2e58b15bcd8bd5d8bf45d), [`e70960d`](https://github.com/junebuild/june/commit/e70960d19ac1f70da54e22f666891ce5b1c4ba77), [`d5e5563`](https://github.com/junebuild/june/commit/d5e55631f488fb73cc804588e539706e8451017e), [`56e0dfd`](https://github.com/junebuild/june/commit/56e0dfd96c16e4b9e8e58b9069e62460f3b05090)]:
  - @junejs/core@0.1.0-dev.0
  - @junejs/server@0.1.0-dev.0

## 0.0.50

### Patch Changes

- [#18](https://github.com/junebuild/june/pull/18) [`ab62955`](https://github.com/junebuild/june/commit/ab62955bd3c5e68c95e2a752761a6bdba732e09c) Thanks [@linyiru](https://github.com/linyiru)! - Configurable content sources: `content.sources` in june.config.ts

  Content no longer has to live under `content/<collection>/`. Config can declare extra source
  directories — including ones outside the app root — that merge into named collections:

  ```ts
  export default defineJune({
    content: {
      sources: [
        { dir: "../docs", collection: "docs" }, // the repo's own docs/, docs-as-code
        { dir: "../schema", collection: "docs", mount: "schema" }, // slugs prefixed schema/…
      ],
    },
  });
  ```

  - Each source scans with the same locale-mirror layout as `content/` (`<dir>/<locale>/…`).
  - `mount` prefixes slugs; a source's root `index.md`/`README.md` becomes the mount's page.
  - A slug collision between sources fails `june gen` loudly, naming both files. A missing
    configured dir is a build error, not a silent skip.
  - Bootstrap-safe: a wrapper-generated config that imports `app/_content.ts` (which only exists
    AFTER the first freeze) self-heals — `june gen` generates the default scan, re-probes the
    config in a fresh subprocess, and regenerates with the sources applied.
  - `june dev` watches configured source dirs (they're outside the app root, invisible to the
    root watcher) and regenerates + restarts on change.

- Updated dependencies [[`ab62955`](https://github.com/junebuild/june/commit/ab62955bd3c5e68c95e2a752761a6bdba732e09c)]:
  - @junejs/core@0.0.48
  - @junejs/server@0.0.51
