# 0008 — Memory layers (profile first, $0 preserved)

Status: M1 in build (2026-09-09)

## Problem

Bot answers from flat transcript only. User-stated durable facts
("namaku arsya", Indonesian language) vanish into history and never
return. Transcript is fallback, not memory architecture (AGENTS.md).

## Research (Sep 2026)

- 2026 consensus (Anthropic context engineering, Zylos/ACON survey,
  Sourcegraph, Red Hat): most agent failures are context failures.
  Window = RAM, stores = disk. Page 5–10 memories per turn, never full
  history. Filter at write time. Keep 30–40% window fill (context rot
  past that). Hybrid retrieval beats single-method ~35%. Structured
  state must live outside lossy summaries.
- CF blocks verified: Workers AI embeddings (bge-small, 10k
  neurons/day free), Vectorize (30M dims/mo allocation on paper, but
  Aug 2026 pricing gates it to Workers Paid $5/mo — avoided).
- Personal scale needs no vector DB: hundreds of facts, cosine
  in-worker against D1 rows is microseconds.

## Roadmap

- M1 profile facts (this sprint): `profile_facts(chat_id, key, value)`.
  Keys: `name`, `language`, `pref.*`. Same detector LLM pass extracts
  them (strict key allowlist, wholesale reject). Whole set injected
  every turn (~50 tokens, zero retrieval cost). Fixes "simpan ke
  ingatanmu" and language matching.
- M2 semantic memory (later): `memories(chat_id, text, embedding)`
  via OpenAI-compatible `/embeddings` on existing Sumopod gateway (no
  new vendor). Per-turn embed + cosine top-5 same-chat + char budget.
- M3 rolling summary (later): `conversation_summaries` at pressure
  threshold; transcript budget shrinks as summary grows; never
  summarize the summary.
- Metrics from day one: retrieval hit rate, injected tokens/turn,
  memory growth. Dashboard reads them when retargeted (0007 step 7).

## Constraints

- $0/mo preserved: no Vectorize, no new vendor, no new binding.
- CF-only divergence: Go repo frozen at v0.1+proactive, no profile
  port. Chat-scoped keys keep trusted-circle multi-user isolation
  (0007 data model already chat-keyed).
