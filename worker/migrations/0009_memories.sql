CREATE TABLE IF NOT EXISTS memories(
  id INTEGER PRIMARY KEY,
  chat_id INTEGER NOT NULL,
  text TEXT NOT NULL,
  embedding TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  last_used TEXT,
  use_count INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_memories_chat ON memories(chat_id);
