# 0018 — FTS5 + RRF hybrid recall (CF)

Status: accepted, shipped, verifying live
Date: 2026-09-10

## Problem

Pure cosine misses what keywords catch: exact names, rare terms,
short Indonesian phrases with weak embedding separation. And cosine
misses nothing FTS catches on paraphrase. Single ranking = single
blind spot either way. Probed remote D1: FTS5 fully works
(CREATE/INSERT/MATCH/rank verified live, probe table dropped).

## Design

1. **`memories_fts` side table** (migration 0015):
   `CREATE VIRTUAL TABLE memories_fts USING fts5(id UNINDEXED, text)`.
   Plain table (not external-content): survives on its own, backfilled
   by `INSERT INTO memories_fts(id, text) SELECT id, text FROM memories`.
   Code syncs writes (save/update/delete paths) — no triggers, D1
   trigger behavior stays unprobed and unneeded.
2. **Query builder escapes everything.** Tokenize (lowercase, alnum),
   double-quote each token, join with OR. Reserved syntax can never
   reach MATCH. Empty token list = skip FTS, cosine-only turn.
3. **RRF merge, k=60.** Cosine top-20 (threshold still 0.72 applies to
   the cosine list) + FTS top-20 by BM25 rank; fused score
   Σ 1/(60+rank). Final top-5 inside the existing 1500-char budget.
   FTS candidates enter regardless of cosine — that IS the point
   (keyword hits cosine misses).
4. **Logging carries deltas.** Recall ledger gains overlap count +
   per-pick source (cos/fts/both). Weekly digest compares hit-rate
   with vs without FTS picks.

## Kill criteria

No measurable hit-rate delta over 100 turns → drop the FTS branch,
keep the table (harmless) or drop it in a later migration. FTS branch
throws nowhere: MATCH failure degrades to cosine-only, logged.

## Verification

- tsc; local D1 (FTS match incl. Indonesian tokens, escaping of
  `"quoted" AND (parens)`, RRF math unit checks, write-path sync,
  backfill shape).
- Live: paraphrase pair (cosine win) + exact-name pair (FTS win) must
  each retrieve; ledger shows mixed sources.
- Cost: one extra indexed SELECT per recall turn; rows-read bounded
  by LIMIT 20.

## Explicit non-goals

Re-tuning threshold/budget (quality experiment stays isolated).
int8/binary/IVF (still on signal per 0017). Relevance feedback /
learning-to-rank (needs volume nobody has).

## Review fix (verify pass, 2026-09-11)

`fuseRecallCandidates` skipped FTS-loop ids already present from the
cosine loop (`if (existing) continue`), so dual-hit docs got only the
cosine-leg score — the FTS leg never boosted them, and the `"both"`
label in the FTS branch was dead code. Fixed: FTS leg now accumulates
`1/(60+rank)` onto the existing entry and upgrades source to `"both"`.
RRF math re-verified by unit check (dual-hit outranks single-leg).
Local D1 re-verified (chat-scoped MATCH, backfill idempotency, cleanup).
