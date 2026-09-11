# 0015 - Work manager: tasks, buttons, Today, prefs (then digests)

Status: accepted, Phase 1 building
Date: 2026-09-10

## Problem

Bot answers and reminds but manages nothing: no dated task list, no
completion tracking, no one-tap triage, no daily rhythm. Research
(Sep 2026, Todoist/Things/Marvin docs, Loggd task data, Goalbot
post-mortem) converges: NL capture + Today + snooze + briefing/review
is the used core; labels/filters/subtasks/Gmail-push are shelfware or
scope poison at this scale.

## Phases

- Phase 1 (this sprint): `tasks` table, detector extraction, inline
  Done/Snooze buttons via `callback_query`, `/today` command,
  prefs + sender gate.
- Phase 2 (next): morning briefing, evening review + rollover,
  deadline warnings, stale triage, `every!` recurrence.
- Phase 3 (only if Phase 2 sticks): ICS feed, capture-to-inbox.

## Schema decision

New `tasks` table; reminders/loops NOT merged. Rationale: reminders
are fire-once pings, loops are open threads, tasks are dated todos
with completion state. Merging live rows risks the working reminder
path for zero user-visible gain. Convergence (if ever) happens in
Phase 2 views, not storage.

```sql
CREATE TABLE tasks(
  id INTEGER PRIMARY KEY,
  chat_id INTEGER NOT NULL,
  title TEXT NOT NULL,
  due_at TEXT,                    -- nullable: inbox has no date
  deadline_at TEXT,               -- nullable: hard cutoff, separate from due
  rrule TEXT,                     -- nullable: every day|weekday|mon,fri...
  status TEXT NOT NULL DEFAULT 'open',  -- open|done|cancelled
  label TEXT,                     -- single-level only, nullable
  created_at TEXT NOT NULL DEFAULT (strftime(...)),
  done_at TEXT
);
CREATE INDEX idx_tasks_chat_status ON tasks(chat_id, status);
CREATE INDEX idx_tasks_due ON tasks(chat_id, due_at);
```

Prefs (same sprint, one table):

```sql
CREATE TABLE prefs(
  chat_id INTEGER PRIMARY KEY,
  quiet_start INTEGER NOT NULL DEFAULT 22,
  quiet_end INTEGER NOT NULL DEFAULT 7,
  brief_time TEXT NOT NULL DEFAULT '07:00',
  created_at TEXT NOT NULL DEFAULT (strftime(...))
);
```

## Transport: callback_query

- Webhook accepts `callback_query` updates (in addition to `message`).
  Same allowlist + secret gate; strangers silently dropped.
  Ops trap (hit live 2026-09-10): webhook `allowed_updates` was
  `["message"]` from the GO-poller era, so presses never arrived -
  buttons rendered, spinner hung, zero worker logs. Any future
  setWebhook MUST pass `allowed_updates=["message","callback_query"]`
  AND re-pass the current `secret_token` (omitting it wipes auth).
- Callback data budget 64 bytes: `done:<taskId>`,
  `snz1:<taskId>` (+1d), `snz3:<taskId>` (+3d). Numeric IDs only.
- Every callback answered via `answerCallbackQuery` (clients hang
  otherwise), then `editMessageReplyMarkup`/`editMessageText` in place.
  No new messages for triage actions.
- Reminder pings and `/today` rows carry Done/Snooze keyboards.

## Detector: tasks[] extraction

`record_state` gains `tasks[]` (`title`, `dueInMinutes?`,
`deadlineInMinutes?`, `rrule?`, `label?`). Partial-accept like
`memories[]`. Save path: INSERT into tasks (no dedupe key - two
identical titles are two tasks; idempotency stays at update_id claim
level). NL dates ("tomorrow 9am", "every mon") parsed by the model
into relative minutes + rrule strings; code validates ranges only.

## /today

Command (leading `/today...`): one message listing due-today +
overdue + open loops count, each task row with Done/Snooze buttons.
Loud send. Unknown commands stay conversational (no help-spam).

## Sender gate

Prefs-loaded per send: inside quiet hours -> hold for briefing
(except deadline warnings, Phase 2); `disable_notification` for
silent sends. Defaults preserve current behavior (22-07 quiet).

## Budgets

Phase 1 adds: 1 detector schema growth (~150 tokens/turn on
non-chit-chat only), callback handler = 2-3 D1 writes, no new cron,
no new bindings. Stays inside Free envelope.

## Explicit non-goals (with reasons)

Gmail push (Restricted-scope audit), two-way calendar sync, subtasks,
labels/filters UI, Pomodoro analytics, Karma/levels, nested projects,
team features. Each refused with a cited post-mortem in research.

## Verification

- tsc clean; local D1 roundtrip (task CRUD, snooze math, prefs gate).
- Burn script extended: task-capture Q + button-callback simulation
  (forged `callback_query` update) + `/today` Q.
- Live: create -> Today lists -> Done edits in place -> snooze moves date.
