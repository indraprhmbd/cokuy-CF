CREATE TABLE IF NOT EXISTS prefs(
  chat_id INTEGER PRIMARY KEY,
  quiet_start INTEGER NOT NULL DEFAULT 22,
  quiet_end INTEGER NOT NULL DEFAULT 7,
  brief_time TEXT NOT NULL DEFAULT '07:00',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
