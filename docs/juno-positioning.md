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
- **Cache / invalidate / live** → table-tag invalidate at the **action boundary**
  (`invokeAction` → `invalidate(table:…)`) + live RSC push; IVM is a future frontier.
  Validated end-to-end with LLM-written code under the real action model (Appendix 5):
  zero ceremony, and multi-table cache dependencies auto-derive from what the read
  touched — requires raw-query auto-tagging (`6563ac9`, load-bearing). Keep the
  explicit `j.reads()/j.writes()` hatch for SQL the parser can't classify. Known
  footgun: a write *outside* an action records no invalidation — mutations must be
  actions (or use the explicit hatch).
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

---

## Appendix 3 — codegen eval v2: the automatic layer, scattered + freshness (2026-06-14)

> Snapshot. Redesigned to hit the automatic layer Appendix 2 said the moat sits in.
> Result: one decisive win, two losses — and a sharper rule for when "automatic" pays.

Same 6-agent / two-arm setup. juno arm now advertises its **automatic** behaviors
(point reads auto-coalesce per request; `cache(fn)` auto-tags by tables read; writes
auto-invalidate cached reads). Baseline arm gets capability-equal but **explicit**
primitives (`batch`, `cache(key, fn)`, `invalidate(key)`). 3 tasks:

| task | juno (3) | baseline (3) | winner |
|---|---|---|---|
| **T1 scattered per-component reads** (30 components each fetch order→user, no shared id list) | ✓✓✓ naive `findBy` → auto-coalesce → **~2 round trips** | ⚠⚠⚠ **N+1 (~60 RTT)**; clever user-cache dedups users but orders stay per-component | **juno, decisively** |
| **T2 cache → write → re-read freshness** | ◑⚠⚠ one wrapped a raw `query` in `cache` (auto-tag may not fire → stale risk); two wrote dead-code cache and bypassed it (uncached) | ✓✓✓ explicit `cache(key)` + `invalidate(key)` → correct + cached | **baseline** |
| **T3 multi-table cached aggregate + write to both** | ◑◑◑ relies on auto-tagging raw `get` reads; also looped `line_items` inserts (extra RTT) | ✓✓✓ explicit `invalidate` + **batched** reads & writes | **baseline** |

**Two findings, one positive one negative:**

1. **Zero-ceremony auto-batch is a real moat the baseline structurally cannot match
   (T1).** Each component writes naive `findBy`; juno coalesces them into ~2 batched
   round trips. The baseline LLMs were *smart* (caching users by id to dedup) yet
   still could not batch order reads across independent components → ~60 RTT.
   → Validates design input B: make point reads auto-batch per request. Build it.
2. **Auto-invalidate, as specified, *lost* to explicit invalidation (T2/T3).** The
   explicit `invalidate(key)` was an obvious anchor all 3 baseline instances used
   correctly. juno's invisible "you never call invalidate" left the LLM no anchor:
   it wrapped raw `query`/`get` in `cache()` (auto-tag likely tracks only table-API
   reads, **not** raw SQL → cache untagged → write doesn't invalidate → **silent
   staleness**), or got confused by the `cache(fn)` signature and skipped caching.
   "Looks correct, silently stale" is the worst failure mode and the magic invited it.

**The sharpened rule:** *automatic is a moat only when it (1) needs zero ceremony
**and** (2) cannot silently break.* Auto-batch `findBy` satisfies both. Auto-invalidate
(as specified) fails both — it replaces an action the LLM expects to take, and its
correctness hinges on auto-tagging the LLM never verifies.

**Design requirements surfaced:**
1. **Build ambient per-request `findBy` auto-batch** (T1 — high value, baseline can't copy).
2. **Rework auto-invalidate for legibility + robustness:** auto-tagging MUST cover raw
   `query`/`get` reads (or those reads must be unrepresentable inside `cache()`), the
   `cache()` API must be LLM-obvious, and **keep an explicit `invalidate` escape
   hatch** — explicit beat implicit for LLM correctness here.

**Caveats:** small N; juno's `cache(fn)` signature was under-specified and likely
handicapped T2/T3 — but that itself is the signal (an under-specified magic API
confuses LLMs). Re-run once the real `cache()` ergonomics are pinned down.

---

## Appendix 4 — eval v2 retest after the auto-invalidate redesign (2026-06-14)

> Snapshot. Closes the implement → retest loop on A3's design input #2. Honest
> result: the fix did what it targeted, and the eval found the *next* bottleneck.

After implementing the redesign — raw `db.query/get/run` through the juno handle
now auto-tag by parsed table name, plus an explicit `j.reads()/j.writes()` hatch
(commit `6563ac9`) — re-ran v2's T1/T2/T3 with 3 juno instances on an accurate
cheat sheet (the accurate, documented behavior is itself part of the fix — the A1
"encode the facts" principle). Baseline was correct in v2 and unchanged, so it
wasn't re-run.

| task | v2 juno | retest juno | what changed |
|---|---|---|---|
| T1 scattered findBy | win | **win** | unchanged (auto-batch) |
| T2 cache → write → re-read | lose (bypass cache) | **still lose** | all 3 again define a `cache()` then bypass it with direct queries — auto-tag is irrelevant when the read never goes through `cache()` |
| T3 multi-table cached + write | lose (raw read silently un-tagged → stale) | **tag fixed** | the raw `db.get` inside `cache()` now parses `orders`/`line_items` and *tags* the entry — but see the Correction: a direct insert doesn't invalidate, so this alone isn't "fresh" |

**Verdict at the time (superseded — see the Correction and Appendix 5).** Read then
as: the fix tags correctly (T3), but cache() ergonomics is the next bottleneck (T2
bypass). Both reads were framing artifacts.

> **Correction (mechanism + Appendix 5).** Invalidation fires at the **action
> boundary** — `invokeAction` reads `trace.writes` and calls `invalidate(table:…)` —
> **not** on a direct insert. Two consequences: (1) T3's "tag fixed" is real but
> insufficient on its own; a *direct* `createOrder` never invalidates, so freshness
> needs the write to be an **action**. (2) T2's "bypass" was actually *correct* —
> you can't cache a read you mutate and re-read in the same function with no action
> between. The real June model is mutation = action; the eval used plain-function
> inserts. So "cache() ergonomics is the next bottleneck" was wrong: re-run under
> the action model (Appendix 5), the magic works end to end.

**Methodology confound (still valid):** the cheat sheet described `cache(fn)` but the
real API is `cache(fn, { key })`. Omitting the key muddied the *cache-usage* signal
— fixed in Appendix 5's cheat sheet.

---

## Appendix 5 — auto-invalidate retest under June's real action model (2026-06-14)

> Snapshot. The fair retest A4 should have run: writes as **actions**, not plain
> functions. Result: the auto-invalidate magic is validated end to end, and a new
> API gap surfaced.

Re-framed T2/T3 so each WRITE is a June action (`defineAction`/`invokeAction`) — how
mutations actually flow — keeping cached reads as `cache(fn, { key })`. 3 juno + 3
baseline (capability-equal but manual: `cache(key, fn)` + `invalidate(key)`).

| task | juno (3) | baseline (3) |
|---|---|---|
| T2 cached list + addPost action | ✓✓✓ `cache` + action → posts write auto-invalidates, zero ceremony | ✓✓✓ correct, but manual `invalidate(key)` |
| T3 cached multi-table dashboard + createOrder action | ✓✓✓ cache auto-tags BOTH orders+line_items (it read both); the action writing both auto-invalidates both — zero keys | ✓✓ correct manual invalidate; 1/3 also shipped a global-count query bug |

**Verdict — auto-invalidate validated; v2's "juno loses" was a framing artifact.**
Under the real action model, all 3 juno instances got correct, fresh data with
**zero cache ceremony** — no keys, no `invalidate()` — including the hard multi-table
T3, where the cache's dependency on *both* tables is auto-derived from what it read
(this needs the `6563ac9` raw-query tagging — load-bearing here). The baseline was
also correct this round (LLMs didn't forget to invalidate), so the edge is **not**
"baseline forgets" — it is:
1. **zero ceremony** — the action just writes; baseline needs key helpers + explicit `invalidate`;
2. **can't-miss completeness** — juno tags exactly what the cache read, so a write to
   any of those tables from anywhere invalidates it; manual keys are correct in a
   two-function task but drift as the app grows;
3. less surface for the kind of query bug 1/3 baseline shipped.

**New gap (design input #5): no filtered-list read.** All 3 juno T2s used
`findBy({ user_id })` for a *list* — but `findBy` is single-row (LIMIT 1). juno's
table API has only `findBy` (one) and `all` (everything); a user's posts needs a
`where`/list read. The LLMs reached for the wrong tool because the right one doesn't
exist. Add a filtered-list read — and it should auto-batch + auto-tag like the rest.

---

## Appendix 6 — upsert retest + capstone: the A3 inputs, implemented & validated (2026-06-14)

> Snapshot. Closes the loop on design input #3 and the whole eval-driven cycle.

With `upsert(values, { onConflict })` implemented and in the cheat sheet, re-ran the
get-or-create task A2 originally failed on (`ensureUser`, TA) plus an insert-or-update
(`saveProfile`, TB). 3 juno + 3 baseline (low-level, write the SQL yourself).

| task | juno (3) | baseline (3) |
|---|---|---|
| TA get-or-create (`ensureUser`) | ✓✓✓ all reach for `upsert` — atomic, one round trip | ✓⚠⚠ 1/3 atomic `ON CONFLICT`; **2/3 fell into check-then-insert** (the exact footgun A2 saw in juno, now in baseline without the primitive) |
| TB insert-or-update (`saveProfile`) | ✓✓✓ `upsert` | ✓✓✓ atomic `ON CONFLICT` (here the upsert intent is obvious to all) |

**Verdict — design input #3 validated.** With the primitive, juno is **6/6 atomic**;
without it, LLMs writing raw get-or-create SQL hedge into a redundant `SELECT`-first
**2/3 of the time**. The primitive turns the obvious call into the atomic one. (TB
doesn't discriminate — "exists → update" reads as upsert to everyone; TA — "exists →
keep" — is where the primitive earns its place.)

### Capstone — the eval-driven cycle

Four evals drove four shipped changes, each: gap found → recorded here → implemented
with tests → re-tested for the behavior change.

| input | what | implemented | LLM-behavior proof |
|---|---|---|---|
| #1 | ambient per-request `findBy` auto-batch | `e834025` (+bench `99b1844`) | scattered `findBy` → 1 query (K→1) |
| #2 | robust auto-tag (raw queries) + explicit `reads()/writes()` hatch | `6563ac9` | A5: 3/3 fresh, zero ceremony, incl. multi-table |
| #3 | atomic `upsert(values, { onConflict })` returning the row | `a465aa1` | this retest: 6/6 atomic vs baseline 2/3 footgun |
| #5 | filtered-list `all(where)` (+ group-batch) | `b9d3b76` | closes the `findBy`-as-list misuse A5 found |

(#4 "cache() legibility" dissolved — A4's reading was a framing artifact; cache works
under the action model, A5.)

**The thesis these earned:** juno's moat is not "LLMs write better code with it" — a
capable low-level API ties on the obvious paths. It is that **the LLM writes the
naive thing and juno's automatic layer makes it fast / correct / fresh**: ambient
batching, action-boundary auto-invalidation with complete (can't-miss) table tagging,
and primitives (`upsert`, `all(where)`) that make the atomic/correct call the obvious
one. The agent-native value to *document* is the calibrated blind-spot facts (A1),
not the API shape — models derive that for free.
