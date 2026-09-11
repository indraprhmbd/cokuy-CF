# 0017 - Retrieval scaling: 256-d + BLOB + bounded window (CF)

Status: accepted, building
Date: 2026-09-10

## Problem

Recall brute-forces all rows as 1536-d JSON floats: ~12KB transfer per
memory, parse + norm per row per turn, unbounded scan. Fine at dozens
of rows, linear into the 10ms CPU wall and D1 rows-read quota.

## Decisions (research-backed, Sep 2026)

1. **Dims 1536 -> 256.** text-embedding-3-small is Matryoshka-trained;
   256-d keeps ~98% recall quality. Request `dimensions` at embed time
   (env `LLM_EMBED_DIMS`, default 256); client always
   truncate+renormalizes to 256 regardless, so a gateway that drops the
   param degrades to the same shape, never a mismatch.
2. **BLOB + prenormalized.** New `emb BLOB` column: Float32 LE,
   unit-norm, 1KB/row (12x smaller than JSON). Query becomes one dot
   loop, no parse, no per-row norm. Old JSON rows self-heal: recall
   path backfills `emb` when missing (one UPDATE per stale row, then
   pure BLOB forever).
3. **Bounded window, no time filter.** `WHERE chat_id=? ORDER BY
   created_at DESC LIMIT 500` + `(chat_id, created_at)` index. No
   recency cutoff: durable facts must survive age. A COUNT(*) rides
   along; `scanned vs total` logged every recall is the cap-warning
   (the 2000-cap alert from before, now at 500 with headroom math).
   D1 rows-read bounded at 500/turn.
4. **Deferred, with triggers:** FTS5+RRF hybrid (next sprint, quality
   deltas measured separately), int8 quant (storage/parse pain),
   binary prefilter + rescore (200-candidate noise), hand-IVF (10k+
   rows). Never: sqlite-vec on D1 (workerd rejects vec0), hnswlib-wasm
   (stale, blows isolate budget), Vectorize (~11 free full-scans/mo),
   Turso (new vendor).

## Verification

- tsc; local D1 (BLOB roundtrip, backfill path, window + count,
  dims-mismatch scoring 0).
- Live: recall ledger unchanged in shape; spot-check a known paraphrase
  pair scores within noise of pre-change values.
- Logs: `recall` gains `{scanned, total, dims}`.

## Explicit non-goals

Re-embedding the corpus via API (backfill is local slice+renorm, zero
token cost). Changing threshold/budget (quality experiment isolated
from this storage sprint).
