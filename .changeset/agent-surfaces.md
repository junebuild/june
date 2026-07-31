---
"@junejs/core": patch
"@junejs/server": patch
---

Agent-level surfaces — per-surface behavior gets a home, and its mechanics get teeth (#149).

How an agent behaves when reached over a given surface is agent behavior, not transport configuration — two agents sharing one channel carry different behavior; the transport carries none. The `channels/<source>.md` overlay convention conflated the two (and failed its blind-guess test 8/10: it reads as deletable docs). It is replaced by two agent-level pieces:

**`instructions.<source>.md`** at the agent root is the surface's instruction variant: discovered by convention (and inlined by `june gen` for the edge), applied to turns whose inbound event arrives through that source — the file alone activates it, composing after the base instructions by default. The name is its own documentation: in the measurement round the shape scored 10/10 on the blind-guess test the old convention failed, 80/80 across the full prediction quiz, and zero divergence on how the locale grammar generalizes (`instructions.slack.zh-TW.md`).

**`agent.ts` `surfaces`** carries the mechanical policy the prose used to beg for: `surfaces: { slack: { mode: "replace", denyTools: ["record_assessment"] } }`. `mode: "replace"` makes the variant the turn's ENTIRE system prompt — the runtime drops the base mechanically instead of the overlay pleading "disregard the above". `denyTools` removes tools from that surface's turns at the same per-turn choke point as `requiresPrincipal`: unlisted to the model and undispatchable (a hallucinated call fails as an unknown tool) — enforcement, not suggestion, and prompt-injection-proof. Both persist through the suspend checkpoint, so resumed turns keep their policy. Fail-loud edges: a `mode` whose variant file is missing throws at assembly/build; a source authored in both the new pieces and the legacy map throws (one source of truth); a policy matching no mounted channel warns (the old silent-no-fire orphan, surfaced).

The prose file stays zero-power — editing it changes what the model is told, never what the system does; all mechanics are typed code. `channelInstructions` remains as the programmatic escape hatch (now also accepting `ChannelPolicy` objects), and `channels/<name>.md` keeps working for one dev-series with a loud deprecation warning at discovery and at `june gen`, pointing to the new location. Channels themselves stay pure transport; channel-intrinsic format guidance for built-in channel authors is a possible follow-up, tracked separately.
