# 0004 - context efficiency (prompt budget, date, usage visibility)

Status: accepted (2026-09-09)

## Decision

Audit of the v0.1 loop found per-turn prompt cost unbounded in practice
(20 messages × 4000 chars ≈ 80K chars worst case), no date awareness in
the system prompt, and no token-visibility for cost tracking. Fix with
three minimal changes, no new dependencies:

- History char budget (~10K chars, newest-first) replaces the fixed
  count of 20. Fetch up to 40 rows, trim oldest-first past the budget,
  always keep the latest message. Bounds cost per turn regardless of
  chat length or message size.
- Inject current date (WIB, UTC+7) into the system prompt at `Generate`
  time. The model previously had no notion of today.
- Capture `resp.Usage` (prompt/completion/total) on the provider as
  `LastUsage`; the agent logs it per turn. Cost goes from invisible
  to one log line.

## Rationale

Char budget beats token counting (no tiktoken-weight dependency for a
personal bot) and beats fixed message count (one 4K paste blows the
count-based budget). Date injection is one line with outsized effect on
reply relevance. Usage logging is the cheapest possible cost control:
you cannot budget what you cannot see.

## Rejected

- Vector retrieval / embeddings: no use case while memory is a raw
  transcript; plan rule is structured state before semantic search.
- Token-exact budgeting via tiktoken: heavy for the accuracy gained.

## Follow-up (separate decision)

P2 memory: `facts` / `tasks` tables + per-conversation rolling `summary`
rewritten by the model every N turns, prepended to the prompt. Closes
the "tasks and open loops are first-class state" plan gap.
