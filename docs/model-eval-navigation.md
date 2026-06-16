# Model-robustness record — the navigation design

A four-round probe of how accurately a strong LLM reasons about June's navigation
design ([`navigation-tiers.md`](./navigation-tiers.md), [`runtime-convergence.md`](./runtime-convergence.md)).
The point was not to grade the model for its own sake but to find where an agent
working on this stack will mislead itself — and to harden the docs there.

Method: 8 independent agents per round, identical prompts, answers committed with
no tool use / no self-checking, then every answer graded against a pre-written key.
Each round raised difficulty along one axis.

## Results

| Round | What it tested | Score | Signal |
| --- | --- | --- | --- |
| 1 | Open-book comprehension + resistance to generic priors (RSC/SPA) | 64/64 | Didn't reach for "just use RSC" on the granularity question |
| 2 | Closed-reasoning + silent-spot (underspecified) + multi-hop | 96/96 | 0 confabulation; perfect separation of answerable vs underspecified |
| 3 | Substrate facts + contradiction injection, **with a warning** | 96/96 | 0 accepted false premises, 0 over-flagged true ones |
| 4 | Contradiction injection, **blind** (no warning, natural phrasing) | **93/96** | First cracks — see below |
| **Total** | | **349/352 ≈ 99.1%** | |

100% held through every round where the model was *told* to watch for traps. The
only failures appeared once the warning was removed (Round 4) **and** the question
rested on a web-platform fact that is itself in flux.

## The three failure modes (all in Round 4)

1. **Sycophancy — accepting a false premise (1 occurrence).** A confidently-worded
   "`no-store` doesn't affect bfcache, right?" was rubber-stamped by 1 of 8 agents.
   The other 7 caught it. Across the blind round, 55 of 56 false premises were
   corrected unprompted (~1.8% miss rate). The model is **not** a yes-man.

2. **Over-correction — "correcting" a TRUE statement into a false one (2 occurrences).**
   The bigger blind-mode risk. Asked to confirm the (correct) claim that a
   cross-document View Transition needs **both** pages to opt in, 2 of 8 agents
   "corrected" it to "only the destination needs to opt in" — which is itself wrong.
   The good-reviewer instinct over-fires on true claims and asserts a wrong fact
   (~5% of true premises). Over-correction outnumbered sycophancy 2:1.

3. **Localization — every error was a substrate fact, never the design.** All three
   misses landed on the two questions whose underlying web-platform behavior is
   genuinely ambiguous or recently-changed. Across all four rounds, **zero** errors
   touched June's design logic (tiers, the format×granularity axes, morph opacity,
   segment-scoping). The error frontier is the platform June sits on, not June.

## The two in-flux substrate facts (authoritative versions)

These are exactly where the model drifted; pin them in user-facing docs with a
date and a source so neither a human nor an agent re-derives them wrong.

**1. `Cache-Control: no-store` disqualifies bfcache.** A page served with
`no-store` is **not** eligible for the back/forward cache in Chrome and Firefox —
the back button does a full reload, not an instant restore. (Chrome is trialing a
*conditional* relaxation for some no-store pages, which is what tempts a model to
say "it's fine now" — it is not, by default.) If you want CDN revalidation without
killing bfcache, use `no-cache` (revalidate-before-use) or a short `max-age`, not
`no-store`. *(Verified 2026-06; behavior is actively evolving — re-check.)*

**2. Cross-document View Transitions require BOTH documents to opt in.** Both the
outgoing and the incoming document must carry `@view-transition { navigation: auto }`,
and the navigation must be **same-origin** (not merely same-site). If only the
destination opts in, the old document never captures its snapshot and no transition
runs. This is also distinct from same-document transitions, which use the
`document.startViewTransition()` JS API — that API does **not** drive cross-document
MPA navigations. *(Verified 2026-06.)*

Related substrate facts the rounds confirmed the model gets right, but which are
worth stating in docs for the same reason (they're load-bearing and easy to invert):

- bfcache restore fires `pageshow` (with `event.persisted === true`), **not** `load`.
- Speculative requests carry `Sec-Purpose: prefetch;prerender` (prerender) or
  `Sec-Purpose: prefetch` (prefetch) — distinguishable server-side; the legacy
  `Purpose: prefetch` is the ambiguous one.
- `moveBefore()` is a **same-document** state-preserving move; it cannot carry a
  node across a document navigation.
- React forbids external mutation of **any** DOM it manages, not just the root —
  which is why morph treats islands as opaque.
- Hashed assets with `immutable` skip even the conditional revalidation request
  within `max-age` (the basis for the `worker.ts` immutable rule).

## Takeaways

- **Trust the model on June's design logic.** Four rounds, zero design-layer errors.
  A coherent, closed design is one the model reasons about reliably — and, inversely,
  writing the design down tightly is itself what keeps the model from drifting.
- **Verify the model on platform substrate, in both directions.** Its only failures
  were web-platform facts, and it erred *both* ways — accepting a false claim and
  rejecting a true one. For anything touching bfcache eligibility, VT opt-in,
  speculation headers, or `moveBefore` boundaries, don't let a single model (or a
  single agent) be the deciding vote.
- **Docs hardening follows the failures.** The places the model drifted are precisely
  the places to write down with a date + source — see the two facts above. The
  user-facing `features-navigation.md` / `features-client-router.md` pages should
  state them explicitly rather than leaving them implicit.
