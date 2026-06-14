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
  `llms.txt` + machine-readable schema/query catalog is step one. The performance
  property "the idiomatic way to write a query is the fast way" is itself an
  agent-native property: an LLM emits near-optimal code without knowing the footguns.

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
