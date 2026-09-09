# 0011 - Robust detector: partial-accept, retry, opportunistic tools

Status: accepted, implementing
Date: 2026-09-09

## Problem

`parseDetection` wholesale-rejects on any flaw: one bad loop title kills
reminders + profile from the same turn. Observed live: reminder requests
lost, bot denies abilities it has. Root pattern: full-response grab +
brace-scrape, no validation feedback, detector runs on every turn.

## Decisions

1. Partial-accept over wholesale-reject. Per-item validation; clamp or drop
   bad items, keep the valid subset. Only hard-fail when no JSON object
   exists at all.
2. One schema-error retry, budget 1, inside `waitUntil` post-reply.
   Re-prompt appends the compact validator error, temp 0.2. User latency
   unaffected. If the model ignores correction, partial-accept still
   salvages the turn.
3. Opportunistic `response_format` + `tools`, never required. Single
   `record_state` function tool carrying the detector schema. Accept three
   shapes in order: OpenAI `tool_calls[].function.arguments`, MiniMax
   `<minimax:tool_call>` XML, current brace-scrape. Probe Sumopod once for
   silent-drop of these params; any drop is harmless, prompt path remains.
   "JSON" stays in the detector prompt (json-mode tripwire).
4. Router + hygiene, all local. Regex pre-gate skips the detector on
   chit-chat when no loops are open. Strip `<think>` leaks before parse.
   Reminder writes idempotent via UNIQUE(chat_id, text, due_at) +
   INSERT OR IGNORE (migration 005). Loops already dedupe via
   openLoopOrExisting.
5. No new dependencies. Hand-rolled validators keep the two-dep bundle
   (grammy, hono); zod stays out on Free-tier memory grounds.
6. Hybrid Workers-AI-Llama detector deferred. Single-model MiniMax until
   the retry rate in turn_stats proves otherwise.

## Explicit non-goals

No Agents SDK, no MCP (negative leverage: no stdio from Workers, no
external server owns our side effects), no Responses API, no vector DB.
Chat Completions stays the portable wire format across
Sumopod / OpenRouter / Ollama / vLLM.

## Verification

- `npm run check` clean.
- Local D1 roundtrip: partial JSON (one bad item) keeps valid items;
   retry path fires once on invalid output; router skips chit-chat;
   duplicate reminder insert is a no-op.
- Live: watch `detect: applied` counts + reminder save rate in logs.

## Amendment 2026-09-09: reminder due clock

Live test showed `due_at` stamped +7h out. Cause was ours, not the model:
`detectAndApply` based `due` on the WIB-shifted wall clock instead of real
UTC. Fixed (commit 6b75081): `due = Date.now() + dueInMinutes`, minute
truncated for the migration-005 idempotency key. Earlier "model added 7h"
theory was wrong; the offset was added by our own code.

If retry rate stays high after probe confirms passthrough works, revisit
the deferred hybrid detector. If tool side effects exceed ~3 actions,
revisit approval-gated patterns (never silently).
