CREATE TABLE IF NOT EXISTS schema_migrations (
	version INTEGER PRIMARY KEY,
	applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS telegram_updates (
	update_id INTEGER PRIMARY KEY,
	received_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
	processed_at TEXT
);

CREATE TABLE IF NOT EXISTS conversations (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	chat_id INTEGER NOT NULL UNIQUE,
	created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS messages (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	conversation_id INTEGER NOT NULL REFERENCES conversations(id),
	role TEXT NOT NULL CHECK (role IN ('user','assistant')),
	text TEXT NOT NULL,
	created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id, id);
