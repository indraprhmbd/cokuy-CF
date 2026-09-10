CREATE TABLE IF NOT EXISTS fact_history(
  id INTEGER PRIMARY KEY,
  fact_id INTEGER NOT NULL,
  fact_table TEXT NOT NULL,
  ts TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  old_value TEXT,
  new_value TEXT,
  source_update_id INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_fact_history_fact ON fact_history(fact_table, fact_id);
