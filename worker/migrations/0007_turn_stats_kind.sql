-- Truthful usage ledger: one row per (update, kind) so detector and
-- summarizer calls stop hiding behind the chat row. Cron rows (kind =
-- 'nudge') use update_id 0 since no Telegram update exists there; the old
-- FK to telegram_updates is dropped for exactly that reason. Existing rows
-- backfill as kind = 'chat'.
CREATE TABLE turn_stats_new(
  update_id INTEGER NOT NULL,
  kind TEXT NOT NULL DEFAULT 'chat',
  prompt_tokens INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL DEFAULT 0,
  total_tokens INTEGER NOT NULL DEFAULT 0,
  model TEXT NOT NULL DEFAULT '',
  latency_ms INTEGER NOT NULL DEFAULT 0,
  error TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY(update_id, kind)
);
INSERT INTO turn_stats_new(update_id, kind, prompt_tokens, completion_tokens, total_tokens, model, latency_ms, error, created_at)
  SELECT update_id, 'chat', prompt_tokens, completion_tokens, total_tokens, model, latency_ms, error, created_at FROM turn_stats;
DROP TABLE turn_stats;
ALTER TABLE turn_stats_new RENAME TO turn_stats;
CREATE INDEX IF NOT EXISTS idx_turn_stats_created ON turn_stats(created_at);
