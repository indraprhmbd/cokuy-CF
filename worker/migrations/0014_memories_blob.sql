ALTER TABLE memories ADD COLUMN emb BLOB;
CREATE INDEX IF NOT EXISTS idx_memories_chat_created ON memories(chat_id, created_at);
