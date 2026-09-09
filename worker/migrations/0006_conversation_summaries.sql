CREATE TABLE IF NOT EXISTS conversation_summaries(
  conversation_id INTEGER PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
  summary TEXT NOT NULL DEFAULT '',
  through_message_id INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT
);
