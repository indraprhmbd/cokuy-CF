-- Reminder idempotency: turn redelivery recomputes the same minute-truncated
-- due_at, so the second insert is a no-op instead of a duplicate nudge.
CREATE UNIQUE INDEX IF NOT EXISTS idx_reminders_dedupe
  ON reminders(chat_id, text, due_at);
