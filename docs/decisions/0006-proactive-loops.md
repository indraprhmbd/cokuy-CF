# 0006 - Proactive loops, reminders, briefing

Status: accepted (2026-09-09)

## Decision

Give Cokuy controlled proactivity in three stages, all riding one
scheduler + outbox foundation:

1. **Follow-up nudges** (first): track open loops per chat, nudge stale ones.
2. **Reminders** (second): natural-language capture, due-tick delivery.
3. **Morning briefing** (third): one 07:00 WIB message, skipped when idle.

Plus a layered deterministic context stack (no vector DB; SQLite is enough).

## Why this order

Follow-ups force-build the durable pieces (loops store, scheduler tick,
outbox with claim-before-send, quiet-hours gate). Reminders and briefing
reuse them without new infrastructure.

## Foundation (Sprint A+B)

Migration 003: `open_loops`, `reminders`, `outbox` tables.

- `open_loops`: id, chat_id, title, context, status open/closed,
  nudge_count, opened_at, last_nudged_at, closed_at.
- `reminders`: id, chat_id, text, due_at, sent_at.
- `outbox`: id, chat_id, kind (nudge/reminder/briefing), ref_id, text,
  dedupe_key UNIQUE, claimed_at, sent_at. Same claim-before-effect
  pattern as `telegram_updates`: a claimed row is owned, a sent row is
  terminal, redelivery never double-sends.
- Scheduler: single ticker goroutine in main, 15-min tick. Each tick runs
  pure SQL checks first (zero LLM cost when nothing is due).
- Quiet hours 22:00–07:00 WIB: unprompted sends never fire inside the
  window; due items queue and flush at 07:00. Replies to user messages
  are unaffected (reactive path has no gate).
- Cap: max 3 proactive sends per chat per day. Silence beats noise.

## Detection (Sprint A)

Post-turn LLM extraction call with strict JSON schema:

```json
{"loops":[{"title":"...","context":"..."}],
 "close_ids":[...],
 "reminders":[{"text":"...","due_in_minutes":120}]}
```

- Runs after reply sent + update marked processed: never delays user reply.
- Due times are relative minutes (model picks offset, Go computes
  `due_at` from WIB now) - no model date math.
- Validated hard: non-empty titles <=200 chars, due 1..43200 min,
  close_ids must exist in that chat's open list. Rejected loudly (log),
  never persisted half-parsed.
- Dedupe: same open title in chat is not re-opened.
- Cost: one extra cheap-model call per turn. Small prompt, JSON-only.

## Context layers (Sprint F, after proactivity works)

Per-turn assembly, each layer budgeted, state block omitted when empty:

```text
system: identity (static persona, ~200 chars)
system: state (open loops, reminders due <48h, briefing flag; ~2k budget)
system: temporal (WIB date, quiet-hours state)
[rolling summary of compacted history, ~1.5k]
[recent transcript, remainder of 10k, newest-first]
user: message (+ truncation marker when cut)
```

Rolling summary maintained by background compaction, not per-turn LLM.
Per-layer token classes logged in `turn_stats`; tune budgets from a week
of real data, not guesses.

## Exit paths

- Detector noise (junk loops): raise staleness threshold / require
  two-turn confirmation before opening a loop.
- Tick cost: tick does SQL only; LLM fires solely for due items.
- Model swap changes JSON discipline: schema validation already isolates
  this; add `response_format: json_object` if the next model needs it.
