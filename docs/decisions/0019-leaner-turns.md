# 0019 — Leaner chat turns (history budget + cache check)

Status: accepted, implementing
Date: 2026-09-11

## Problem

Measured 2026-09-11 (WIB day, 14 chat turns): prompt tokens crept
1906 → 2578 (+35%) across the day. Spend is 82% chat prompts
(system + history); detect gating works (5/14), recall embeds are noise
(147 tokens/day). `HISTORY_BUDGET_CHARS = 10000` lets long bot answers
re-send every turn; the 60-message compaction threshold never fires at
this pace, so the budget is the real (and only) history control.

## Design

1. **History budget 10000 → 6000 chars.** Recent turns dominate relevance;
   all of today's turns fit comfortably inside 6k. Caps the plateau ~30%
   lower. One constant, zero behavior risk at current volume.
2. **Prompt-cache check (no code yet).** ~1k tokens/turn are byte-static
   (persona + tool guide + schemas + command appendix). If Sumopod/gateway
   honors prefix caching, adopt it: up to ~40% prompt cut, zero quality risk.
3. **Compaction threshold revisit (deferred).** 60 messages is unreachable;
   either lower to ~30 or accept the budget as the mechanism. Decided by the
   eval set, not by feel.

## Kill criteria

Eval-set comparison (once it exists): no quality regression on recent-context
questions at 6k vs 10k. If regression appears, revert the constant.

## Static system budget (2026-09-12 amendment)

Measured: base 1460 chars (~365 tokens) + guide ~480 (~120) + 5 schemas
~1800 (~450) = ~1k static tokens on armed turns, ~365 on chit-chat. The
static prompt grew ~40% in one day of individually-justified additions
(appendix, /status, set_reminder). Rule going forward: ~1k tokens is the
budget; new prompt text or new tools must argue for their tokens in the
decision doc. If prompt caching lands, revisit.

## Explicit non-goals

Touching detect gating (works), recall embeddings (147/day is theater),
tool schemas (price of working memory tools). Latency work (bubble pauses
are post-reply wall time, not token cost).
