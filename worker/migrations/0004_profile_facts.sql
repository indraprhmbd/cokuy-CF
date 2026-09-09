CREATE TABLE IF NOT EXISTS profile_facts (
	chat_id INTEGER NOT NULL,
	key TEXT NOT NULL,
	value TEXT NOT NULL,
	updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
	PRIMARY KEY (chat_id, key)
);
