CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(id UNINDEXED, text);
INSERT INTO memories_fts(id, text) SELECT id, text FROM memories
  WHERE id NOT IN (SELECT id FROM memories_fts);
