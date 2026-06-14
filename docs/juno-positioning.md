# Juno positioning & design rationale

> **Status: internal design rationale. Not for the public site / not synced outward.**
> It names external references (a query builder, a major ORM, a sync engine) for
> traceability of *why* we chose what we chose. Outward-facing copy must stay
> competitor-neutral — use the **Public positioning** section at the bottom for the
> language we actually ship. Pairs with `docs/juno-sqlite-performance.md` (numbers)
> and `bench/scenarios/` (re-runnable evidence).

Juno is June's async data layer over the `JuneDb` contract
(`packages/core/src/resources.ts`) — sqlite / D1 / Postgres alike. Goal:
**lightweight, best-in-class performance, and the best data layer for agents/LLMs.**
This doc fixes Juno's coordinates against three studied references.

## The four pillars

1. **Query + types + dialect** — an ergonomic, fully-typed query surface that
   compiles to SQL across dialects.
2. **Compile-once performance** — the idiomatic call is the fast call; no
   opt-in "prepared mode" the caller must know about.
3. **Edge/distributed correctness** — collapse round trips (auto-batch) and route
   reads to the nearest replica (per-request session). The D1 axis is round-trip
   count, not engine (see the perf doc).
4. **Cache / invalidate / live + agent-native** — writes auto-invalidate by table
   and push live RSC; the schema + query surface is machine-readable for LLMs.

## Reference 1 — typed query builder (adopt its architecture, beat its default)

**What it does well, that we adopt:** an immutable operation-node **AST** produced
by a fluent builder, walked by a **visitor compiler** into SQL + placeholder
params; **dialects are compiler subclasses** overriding vendor syntax; full type
inference flows from a declared `interface DB { table: RowType }` with **zero query
codegen** (a codegen tool only generates that interface from a live DB — optional,
one-directional); a `sql` **escape hatch** where `${}` is auto-parameterized and
`ref`/`table`/`id` mark identifiers; cross-cutting concerns are **AST passes**
(plugins), not string hacks.

→ Juno's query layer should be this, replacing the spike's string-concat prototype.
It is the right shape for multi-dialect (sqlite/D1/Postgres) correctness.

**Where we go beyond it:** that reference **recompiles the AST to SQL on every
`execute()`** — caching is an opt-in manual `.compile()`. Our spike found the same
gap and the same fix: cache by a structural key so **compile-once is the default**,
not opt-in. This is pillar 2, and it's a real differentiator: idiomatic code stays
at the raw floor (~97% in the spike) without the caller knowing about prepared
statements.

## Reference 2 — a major ORM that removed its native engine (external validation)

That ORM shipped a release making a **TypeScript/WASM query compiler the default
and removing the Rust binary entirely** — reporting ~90% smaller bundles, up to ~3×
faster queries, ~70% faster type-checking, and the ability to run on Workers / Bun /
Deno. Their own analysis: the dominant cost was **the serialization boundary
between JS and a separate native engine process**, not the language.

→ This is direct external validation of our spike's "**don't go native**" finding
(rusqlite ≈ better-sqlite3; the C engine is the floor and in-process JS already sits
on it). Juno is in-process JS over a sync driver from day one — it never builds the
boundary that this ORM spent years removing. Strong basis for pillar 2's framing.

## Reference 3 — a local-first sync engine (the cache/invalidate/live frontier)

Architecture: a client store (optimistic reads/writes) backed by a server cache
that holds a DB replica and syncs **row subsets driven by the queries the app runs**
(query is the unit of sync, not the table). Query results stay live via an **IVM
(incremental view maintenance)** engine — a differential-dataflow-style operator
pipeline (`source → filter → join → take → fan-out/fan-in → view`) that pushes a
**delta** on each row change and updates only the affected part of a materialized
view, never re-running the query.

**The spectrum this places Juno on:**

| | Juno today | The sync engine (IVM) |
|---|---|---|
| invalidation unit | **table tag** (`recordTableWrite` → drop `table:<name>` → refetch) | query / row delta |
| on write | coarse: drop + refetch all queries for that table | fine: delta through the pipeline, only affected rows update |
| cost | cheap; over-invalidates | a whole dataflow engine; near-zero recompute |

→ Juno is a **server-side RSC data layer, not a local-first sync engine** — it must
not rebuild differential dataflow. But four things transfer:

1. **`llms.txt` + machine-readable self-description (do now, cheap, on-brand).**
   That engine ships an LLM-friendly `llms.txt`. This *is* pillar 4: Juno should
   publish its schema + query catalog + API as a first-class machine-readable,
   LLM-optimized artifact.
2. **Invalidation granularity is a dial, not a fork.** Table-level tagging is the
   pragmatic sweet spot; keep it. If over-invalidation bites, refine toward
   query-shape / touched-rows — later, not pre-emptively.
3. **Surface errors and conflicts (discipline).** Field reports of that engine flag
   silently-reverted rejected mutations and undocumented conflict resolution as its
   worst gap. Juno's auto-invalidate + live push must have explicit semantics for
   failed writes, rejected mutations, and concurrent writes — never swallow failure.
4. **IVM operator pipeline = the reference for "live query updates in place"** if
   Juno ever wants live RSC to push deltas instead of invalidate+re-render. Frontier,
   not now.

## Juno's coordinates (the synthesis)

- **Query / types / dialect** → adopt the AST + visitor-compiler + zero-codegen-type
  architecture; **make compile-once the default** (beyond opt-in).
- **Native?** → No. In-process JS over a sync driver. Externally validated.
- **Edge / D1** → round-trip count is the axis: auto-batch the render wave into one
  `DB.batch()`; route reads through a per-request session (read replication). Both
  are framework-only wins a plain library can't do. (See perf doc.)
- **Cache / invalidate / live** → keep pragmatic table-tag invalidate + live RSC
  push; borrow the error-surfacing discipline; IVM is a future frontier.
- **Agent-native** → the least-explored axis among references = the moat candidate.
  `llms.txt` + machine-readable schema/query catalog is step one. Refined by the
  codegen eval (Appendix 2): the moat is **not** "LLMs write better query code with
  juno" (there it ties a capable low-level API) — it's that **the LLM writes naive
  code and juno's automatic layer (compile-once, auto-invalidate/live, request-scoped
  batching) makes it fast/correct/fresh underneath**, plus encoding the blind-spot
  facts (Appendix 1) that models otherwise assert wrong.

## Migrations (resolved direction)

The hard, expensive part of migrations is the **schema-diff engine** — correctly
diffing desired vs current and planning a safe migration (renames, type changes,
constraints, data moves), with linting for destructive changes. A best-in-class
declarative tool ("Terraform for databases") has spent years on those edge cases;
it is a Go binary (also a Go library), dev/CI-time, language-agnostic, with diff +
lint + multi-dialect support.

Decision — **build the light path in-library, lean on the external tool for the
hard path, never rebuild the diff engine:**

1. **Ship an in-library imperative migrator first.** A `Migrator` + schema builder;
   up/down are TS functions. Pure JS, zero external deps — Juno is end-to-end usable
   and "runs anywhere JS runs" holds (migrations are dev/CI-time, but no binary to
   install for the basic path).
2. **Offer declarative migrations as an opt-in dev-time path** on top of the
   external tool: Juno's single TS schema (the same one that drives types) is emitted
   to a format the tool consumes, so users who want declarative + safety-linting opt
   into its binary at dev time. Juno does **not** reimplement diffing; it stands on
   the best one. Runtime stays pure JS. Declarative also suits pillar 4 — "here is
   the schema I want" is more LLM-friendly than hand-written `ALTER`s.
3. **Do not build in-house JS-side schema diffing** unless demand forces it — the
   "looks easy, isn't" trap the mature tools each paid for.

**Unifying principle:** the schema definition is **one artifact** feeding (1) types,
(2) the query layer, and (3) migrations — the schema-as-code spirit shared by the
typed-query-builder and the declarative-migration references.

---

## Public positioning (competitor-neutral — the outward language)

- Juno is a lightweight, typed data layer that stays at the raw-driver performance
  floor by compiling each query shape once — idiomatic code is fast code, no
  prepared-statement ceremony.
- It runs in-process with no native binary, so it deploys anywhere JavaScript runs
  (Node, Bun, Workers) with nothing to compile.
- On the edge it collapses round trips automatically (render-level auto-batch) and
  routes reads to the nearest replica, because at network latency the only thing
  that matters is round-trip count.
- A write auto-invalidates exactly the data it touched and pushes live updates, with
  no manual revalidation.
- It is built to be read and written by agents: a small, regular API and a
  machine-readable schema + query catalog, where the obvious way to write a query is
  also the fast and correct way.

---

## Appendix — what LLMs get right vs wrong about this design (blind test, 2026-06-14)

> Snapshot. The design is still evolving; re-run and revise as it changes.

We gave 8 fresh, parallel model instances this design's *shape* (no measured
numbers, no external-fact answers) and 12 questions, required blind first-shot
answers (no tools, no verification, no second-guessing), then scored against our
measured ground truth. Purpose: gauge how accurately a model reasons about a
design of this shape — which directly informs what an *agent-native* data layer's
docs should contain.

**Result:**

- **Qualitative / directional reasoning — near-perfect (8/8), including the
  counterintuitive.** Models reliably derived: compile-once ≈ raw floor; no native
  engine needed; a typed query builder doesn't cache compiled SQL by default;
  removing a native engine made a major ORM *faster*; and the two traps —
  native-Rust ≈ better-sqlite3 on point reads, and WAL is a no-op on `:memory:`.
  The *shape* is legible to models.
- **Quantitative magnitudes — systematically wrong, biased toward "textbook
  moderate" values.** Models guessed WAL insert ≈ 3–4× (real ~22×), session/replica
  reads ≈ 2× (real ~19×), batch-of-100 = a clean 100× (real ~80× after overhead),
  named-bind insert ≈ 90% of raw (real ~75–81%). Extreme real-world numbers (fsync
  cliffs, network RTT) and real-world overhead both get smoothed toward the middle.
- **Reputation overrode measurement.** All 8 said bun:sqlite > better-sqlite3 on
  single-row `.get()`; our x86 measurement is the reverse. (Arch/workload-dependent —
  but the model asserted, unanimously and confidently, what measurement contradicts.)
- **The one non-obvious *consequence* split the model majority-wrong.** "Render
  auto-batch vs naive *concurrent* reads" — 5/8 said large (>5×); real is ~1.6×,
  because concurrency already amortizes the RTT (the catastrophe is *sequential*
  N+1, not concurrent). This is the highest-value finding: a consequence that
  follows from the design but that most model instances get backwards.
- **Consistency ≠ correctness.** Unanimous answers included a unanimous *wrong* one.

**Implication for the agent-native pillar.** Don't spend the machine-readable docs
on the API shape — models derive that for free. Spend them on the **blind-spot
list**: the calibrated magnitudes and counterintuitive consequences a model will
otherwise assert wrong. Current list (revise as measured):

1. WAL on a file DB (synchronous=NORMAL) is **~20× on autocommit single-row
   inserts** (not ~3–4×); and a **no-op on `:memory:`**.
2. Cross-region reads via a **per-request session route to a replica ~19×** faster
   (230ms→12ms) — and **only** through the session; a plain `prepare()` still hits
   primary.
3. Render auto-batch beats naive **concurrent** reads only **~1.5–2×** at real
   latency; it beats **sequential** N+1 by ~N. Credit batching for killing
   *sequential*, not for beating *concurrent*.
4. One `DB.batch()` of N collapses to ~1 RTT → speedup ≈ ~0.8·N (overhead), e.g.
   ~80× at N=100, not a clean N×.
5. On x86, **better-sqlite3 ≥ bun:sqlite** on single-row `.get()` (reputation says
   otherwise; arch/workload-dependent).
6. Named-bind insert is **~75–81% of raw positional** insert, not ~90%.
7. An async/remote client per call is **~10–25× slower** than the same engine
   synchronous — keep the hot path sync, batch the remote.

---

## Appendix 2 — codegen eval: do LLMs write better data code with juno? (2026-06-14)

> Snapshot. This materially **refines the agent-native thesis** above.

Setup: 6 fresh parallel model instances, two arms (3 each) — juno's high-level API
vs a capable low-level async DB API (both expose `batch()` and `prepare()`, so the
fast path is reachable in either). Same 5 realistic D1 tasks, blind first-shot (no
tools, no execution), then we hand-scored each solution for correctness /
round-trips / safety / footguns.

**Result — on LLM-written query code, juno ≈ the capable baseline:**
- T1 (30 rows by id): both arms 1 round trip (juno loader / baseline `WHERE id IN (...)`).
- T2 (orders + line_items): both 2 round trips, no N+1; juno fell back to raw SQL
  (it has no relation affordance).
- T3 (idempotent upsert): the baseline went straight to atomic
  `INSERT … ON CONFLICT DO NOTHING` + select (2 RTT); juno's ergonomic `findBy`
  **nudged a check-then-insert** (extra RTT), and one instance dropped `created_at`.
  The higher-level API led to a slightly *worse* pattern.
- T4 (search by user-provided string): all 6 parameterized and even escaped LIKE
  wildcards — no injection in either arm.
- T5 (hot `getUserById`): ~2/3 of **both** arms stashed the cache/loader on the
  long-lived `db` handle → cross-request leak. juno's loader did not prevent it.

So "LLMs write better code with juno's higher-level API" is **not supported here** —
capable models + a clean low-level API already reach set queries, parameterization,
and upsert, and a high-level affordance can backfire (T3).

**The reframe.** A codegen eval can only see code the LLM writes. juno's real wins
are the **automatic layer the LLM never writes** — compile-once caching, auto
cache-tag + invalidate + live, request-scoped batching. So the agent-native thesis
shifts:

> from "LLMs write *better code* with juno"
> to&nbsp;&nbsp;&nbsp;"LLMs write *naive* code and juno makes it fast / correct / fresh underneath."

The moat is what the developer-or-agent **doesn't have to get right**.

**Design inputs this surfaced:**
1. Make request-scoping **structural** — bind loaders to a request context that
   can't be stashed on the long-lived handle, so the T5 cross-request leak is
   unrepresentable (both arms hit it = a real blind spot).
2. Add an **atomic upsert** primitive so the obvious path is the atomic one, not
   `findBy`-then-insert — and **eval every new API primitive this way**: does it
   steer the LLM to the fast path, or backfire like T3's `findBy`?
3. Relation loading (`with`/include or FK loader) — juno currently adds nothing over
   raw for T2; only worth shipping if it is correct + fast by default.

**Caveats:** small N (3/arm), 5 tasks; T1 handed an `ids[]` array (invites a set
query — under-tests scattered N+1); and the tasks did **not** exercise juno's
automatic invalidation / live / compile-once, which is exactly where the moat now
sits. Next round: scattered per-component loads, and a read-after-write freshness task.
