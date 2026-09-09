# 0010 - Reminder Shape Bug and Capability Denial

Date: 2026-09-09

## Context

Gateway request log (`_temp/req-log.md`, 25 reqs, Sep 9 09:34-10:23, $0.0012, 25/25 Success) shows healthy turn pairs: chat call ~1100 in / ~100 out, detector ~250 in / ~200 out. But D1 after 17 turns: open_loops 0, reminders 0, outbox 0. User asked `bisa ingetin jam 12 nanti ga` and the bot replied it cannot send first or give reminders. Smart-initiative plan exists in schema plus 15-min tick, but nothing ever fills the tables.

## Decision

1. Fix detector prompt/parser key mismatch (`detect.ts`).
2. Add capabilities block to chat system prompt (`llm.ts`).

## Rationale

Bug: prompt shape tells the model snake_case (`due_in_minutes`, `close_ids`), parser reads camelCase (`dueInMinutes`, `closeIds`). Reminder path gets `due` = undefined, throws, wholesale reject discards the whole detection. `close_ids` fails silent (defaults to []). Loops/profile keys match, which is why M1 profile facts saved fine while reminders never did. Single explicit reminder request in history produced zero rows: matches.

Denial: system prompt never describes proactive abilities, so the model invents limits. Fix is a capabilities block: reminders from NL with WIB-relative math, open-loop tracking across turns, delivery even when user idle, quiet hours 22:00-07:00 WIB. Model must ack, never deny.

## Tradeoffs

- Prompt-shape fix is one-line class, zero schema change, no migration.
- Capabilities block costs ~60 tokens per chat turn (~$0.000002). Negligible.
- Detector stays wholesale-reject; strictness kept, only the contract fixed.

## Consequences

- `ingetin X` requests now persist to reminders and tick delivers them.
- `close_ids` actually closes loops; loop lifecycle works end to end.
- Bot ack wording becomes committal ("oke, nanti kuingetin jam 12").

## Revisit trigger

- If reminders table stays empty after live NL tests, suspect relative-time math ("jam 12" WIB conversion) and add explicit now-WIB injection into detector prompt.
- Gateway log anomaly (41 in / 980-2040 out rows) still unexplained; open one Gateway log body if spend or behavior looks off.
