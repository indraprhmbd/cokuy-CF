CREATE TABLE IF NOT EXISTS tasks(
  id INTEGER PRIMARY KEY,
  chat_id INTEGER NOT NULL,
  title TEXT NOT NULL,
  due_at TEXT,
  deadline_at TEXT,
  rrule TEXT,
  status TEXT NOT NULL DEFAULT 'open',
  label TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  done_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_tasks_chat_status ON tasks(chat_id, status);
CREATE INDEX IF NOT EXISTS idx_tasks_due ON tasks(chat_id, due_at);
