---
"@junejs/core": patch
---

Minted turn ids are now globally unique and lexically time-sortable (#95): `t_` + a monotonic ULID replaces the per-actor sequence. The old ids collided in both dimensions — across sessions (every session's first turn was `t1`, useless in any table keyed by turnId), and within one session across a DO hibernation (the in-memory seq reset re-minted `t1`, which the engine then treated as a redelivery of the old turn and silently replayed its steps). Explicitly passed `turnId`s are untouched; legacy `t<n>` ids sort before every new id, so a mixed ledger stays ordered across the migration boundary. New export: `mintTurnId()`.
