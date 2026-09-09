# 0012 — Learning loops: counters first, LLM only where code can't decide

Status: accepted, Phase A building
Date: 2026-09-09

## Problem

Policy static, metrics write-only. `turn_stats` records everything and
informs nothing. No dissatisfaction signal captured; behavior never
changes from experience.

## Principle (research-backed, Sep 2026)

Memory with write-time discipline + counters that read themselves. No
training, no reward models, no vector DB at single-user scale. Explicit
user statements beat inferred preferences; implicit signals (rephrase,
correction) are dashboard/eval inputs, never automatic prompt rewrites
(noisy, perverse incentives). Fine-tuning only after design + evals
validate — not this scale, not this budget.

## Phase A — zero LLM (this sprint)

1. Correction + rephrase counters. `turn_feedback(update_id PK,
   is_correction, is_rephrase)`. Correction = regex on user text
   (no/wrong/bukan/salah/maksud gue/jangan/...). Rephrase = token
   Jaccard >= 0.6 vs previous user turn. Pure code, ~30 lines, one
   write per turn in waitUntil.
2. Readable ledger. Weekly digest = one SQL query (counts by kind,
   error %, corrections, rephrases). No code. Kill if never opened
   in 30 days.
3. Precedence injection. Profile facts recency-sorted with an explicit
   latest-wins header. Prompt template only. Kill if correction rate
   doesn't drop over 100 turns.

## Phase B — deferred until counters prove signal

4. Preference overwrite with Telegram confirm gate.
5. Weekly batched dedupe, one cheap call.
6. Golden set of 12 prompts in D1, deterministic checks.

## Explicit non-goals

Fine-tuning, RLHF/RLAIF, preference models, embedding retraining,
vector DB, per-turn dreaming. Revisit only past 10k turns + paid
tier + validated evals.

## Weekly digest query

```sql
SELECT kind, COUNT(*) AS turns,
  SUM(CASE WHEN error != '' THEN 1 ELSE 0 END) AS errors
FROM turn_stats GROUP BY kind;
SELECT COUNT(*) AS corrections FROM turn_feedback WHERE is_correction = 1;
SELECT COUNT(*) AS rephrases FROM turn_feedback WHERE is_rephrase = 1;
```
