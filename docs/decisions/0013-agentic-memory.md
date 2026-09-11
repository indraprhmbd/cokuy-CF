# 0013 - Agentic memory: semantic recall + memory-as-tools (CF)

Status: accepted, Sprint 1 + Sprint 2 shipped
Date: 2026-09-09

## Embed source (decided)

Sumopod `/embeddings`, model `text-embedding-3-small` ($0.02/1M,
cheapest of the three by 6-7x, 1536 dims, plenty at personal scale).
Query ~20 tokens; 1k recalls/day stays sub-cent. Interface kept
swappable (`embed(texts) -> float[][]`) if source ever changes.

## Problem

Retrieval is dumb, composition is smart. The model only sees what it is
handed: profile facts by exact key, transcript by recency, summary by
lossy compression. Anything outside that triangle is invisible (aged-out
preferences, paraphrased facts, mid-history decisions). No query
embedding exists, so recall quality is capped at keyword luck. The
post-turn detector decides everything paternalistically; the model can
never ask for what it needs mid-turn.

## Principle

Memory as tools, not more injection. The model calls `recall_memories`
when it senses a gap and asserts `save/update/forget_fact` when it
learns something; deterministic code validates, gates, and persists.
Consolidation runs offline so the store improves over time instead of
accumulating contradictions. MCP-wrap nothing: tools are local D1
functions until a second process needs them.

## Design

### New table (migration 009)

```sql
CREATE TABLE memories(
  id INTEGER PRIMARY KEY,
  chat_id INTEGER NOT NULL,
  text TEXT NOT NULL,
  embedding TEXT NOT NULL,          -- JSON float array (TEXT over BLOB:
                                     -- D1-friendly, ~12KB at 1536 dims)
  created_at TEXT NOT NULL DEFAULT (strftime(...)),
  last_used TEXT,
  use_count INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_memories_chat ON memories(chat_id);
```

`fact_history(fact_id, ts, old, new, source_update_id)` for audit
(migration 010, same sprint).

### Embed source (decided, see header)

Probe on first live use logs dims; pipeline wiring follows only after
shape confirms. Fallback chain stays: embed fails -> turn proceeds with
zero memories, logged, never blocking.

### Turn pipeline changes

1. Turn start: embed user query (skip when router says chit-chat and no
   loops open - same pre-gate as detector). Brute-force cosine over
   same-chat rows only, top-5 above threshold 0.72, char budget 1500.
   Inject with memory IDs (`[m12]`) so use is trackable. Bump
   `last_used`/`use_count` on injected rows.
2. Main generate call gains three tools: `recall_memories`,
   `save_fact`, `update_fact` (`forget_fact` deferred to weekly
   consolidation, never mid-turn). Max 2 tool steps (wall-time cap).
   Tool args validated exactly like detector payloads (partial-accept,
   strict keys, length clamps).
3. Overwrite guard: `update_fact` on an existing key requires the
   model's stated reason AND surfaces a Telegram confirm on conflict
   (Phase B of 0012 pattern). No silent overwrites, ever.
   As-shipped deviation: memory text updates apply immediately with
   full audit (`fact_history` old/new/source turn) because mid-turn
   confirmation is impossible; the confirm gate stays scoped to
   profile-fact overwrites (higher stakes, explicit identity data).
   Weekly consolidation can revert bad memory updates from history.
4. Post-turn detector stays as safety net; `record_state` schema gains
   optional `memories[]` (candidate long-term memories from the turn).
5. Failure modes: embed call fails -> turn proceeds with zero memories
   (logged, never blocking). Tool call invalid -> validation error fed
   back once, then dropped (0011 retry pattern).

### Consolidation (extends 0012 Phase B dedupe)

Weekly tick: feed `memories` + `fact_history` to the summarizer call -
merge duplicates, resolve conflicts (recency wins, session over global),
drop `this-trip` ephemerals, delete superseded rows. One cheap call.

### Metrics (extends turn_stats kinds)

- `recall` rows: memories injected count, top score, threshold.
- Hit heuristic: injected memory ID cited in tool args or reply, or no
  correction within 2 turns. Hit-rate = useful / injected.
- Kill criteria: hit-rate <20% over 100 turns -> disable injection,
  keep on-demand `recall_memories` tool only. Consolidation output ==
  append 3 weeks straight -> drop to manual.

### Budgets (hard)

- Recall path adds <= 1 embed call + <= 2 tool steps per turn, only on
  non-chit-chat turns. CPU: cosine over thousands of rows is
  microseconds, inside 10ms Free budget. Storage: one BLOB per memory
  (~3KB at 768 dims), D1 Free headroom is orders above.
- No new bindings, no new vendor (unless Option B, which is local),
  no framework, no MCP.

## Explicit non-goals

Vector server (Qdrant/Milvus) until corpus or filter pressure proves
it. Reranker model until top-k quality measurably fails. `forget_fact`
as a live tool. Auto-prompt rewrites from metrics. MCP wrapping.

## Verification

- tsc clean; local D1 roundtrip (cosine math unit test, threshold
  behavior, budget clamp, idempotent writes).
- Live probe first: embed shape/dims from chosen source before any
  pipeline wiring.
- Golden turns: paraphrase recall test ("kopi pahit" stored weeks ago,
  asked as "minuman favorit gue apa") must retrieve; overwrite conflict
  must trigger confirm, never silent-write.
- Logs: `recall` counts + hit-rate in weekly digest (0012 query grows
  two lines).

## Backport

On green: CONTRIBUTING item for GO (sqlite-vec or same brute-force
table, same tool schemas). CF proves, GO adopts.
