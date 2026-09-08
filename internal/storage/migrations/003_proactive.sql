CREATE TABLE IF NOT EXISTS open_loops (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	chat_id INTEGER NOT NULL,
	title TEXT NOT NULL,
	context TEXT NOT NULL DEFAULT '',
	status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')),
	nudge_count INTEGER NOT NULL DEFAULT 0,
	opened_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
	last_nudged_at TEXT,
	closed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_loops_chat_status ON open_loops(chat_id, status);

CREATE TABLE IF NOT EXISTS reminders (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	chat_id INTEGER NOT NULL,
	text TEXT NOT NULL,
	due_at TEXT NOT NULL,
	sent_at TEXT,
	created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_reminders_pending ON reminders(sent_at, due_at);

CREATE TABLE IF NOT EXISTS outbox (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	chat_id INTEGER NOT NULL,
	kind TEXT NOT NULL CHECK (kind IN ('nudge','reminder','briefing')),
	ref_id INTEGER,
	text TEXT NOT NULL,
	dedupe_key TEXT NOT NULL UNIQUE,
	claimed_at TEXT,
	sent_at TEXT,
	created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_outbox_pending ON outbox(sent_at, claimed_at);
