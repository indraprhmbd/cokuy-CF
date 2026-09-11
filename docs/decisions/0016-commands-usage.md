# 0016 - Command surface + usage tool (CF)

Status: accepted, building
Date: 2026-09-10

## Set (8 commands, no more)

- `/start` - first contact (allowlisted only, strangers keep silent drop).
- `/help` - command list, one line each.
- `/today` - exists (0015). Unchanged.
- `/brief` - on-demand briefing; reuses `handleToday` renderer, cron comes later.
- `/usage` - token + USD readout from the ledger, today + 7d, per-chat.
- `/remember <fact>` - explicit memory save (embed + store, ack after write).
- `/forget <keyword>` - deletes matching memories + profile facts, reports
  what was removed. Explicit user delete is the only silent-write path.
- `/quiet [HH:MM-HH:MM]` - view/set quiet window in prefs. No args = show.

Plus `get_usage` LLM tool returning the same numbers as JSON so the
model answers cost questions truthfully instead of guessing.

## Data changes (migration 0013)

- `turn_stats ADD COLUMN chat_id DEFAULT 0`. Ledger goes per-chat:
  three users share one bot, nobody sees others' volume. All 7
  `recordTurnStat` call sites pass chatId (compact path takes it as a
  param; tick nudge already has it).
- No new tables. Prefs/memory/task rows already exist.

## Pricing

USD math needs rates the worker doesn't have. New optional vars
`PRICE_IN_PER_M` / `PRICE_OUT_PER_M`, defaults 0.03 / 0.12 (current
Sumopod MiniMax promo). Same constants feed `/usage` and `get_usage`.

## Routing

Command router in a new `commands.ts`, called from `/telegram` after
the allowlist gate, before the turn. Everything runs in waitUntil like
`/today`; commands never enter the LLM turn (except via `get_usage`
tool results). Unknown `/foo` = short hint, not an LLM call.

## Verification

- tsc clean; local D1 (usage sums incl. per-chat isolation, remember
  roundtrip, forget LIKE behavior, quiet parse/reject).
- Burn: `/usage` Q + cost Q (tool path) + `/remember` + `/forget`.
- Live: one of each command, then ledger check.

## Explicit non-goals

`/settings` maze, `/export` (d1 CLI stays the path), `/stats` health
(dashboard's job), `/cancel` (buttons + NL cover it).
