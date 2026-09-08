// Package-equivalent of internal/storage (sqlite.go + proactive.go), ported
// 1:1 to D1. Same claim-before-effect patterns: ClaimUpdate owns an
// update_id, ClaimOutbox owns a send, so redeliveries and restarts never
// double-reply or double-send. Timestamps use the same strftime-compact UTC
// format so lexicographic comparisons stay correct.

export interface ChatMessage {
  role: string;
  text: string;
}

export interface TurnStat {
  updateId: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  model: string;
  latencyMs: number;
  error: string;
}

export interface OpenLoop {
  id: number;
  chatId: number;
  title: string;
  context: string;
  nudgeCount: number;
  openedAt: string;
}

export interface Reminder {
  id: number;
  chatId: number;
  text: string;
  dueAt: string;
}

export interface OutboxMessage {
  id: number;
  chatId: number;
  kind: string;
  refId: number | null;
  text: string;
}

/** Atomically records update_id. True = first claim; false = duplicate, skip. */
export async function claimUpdate(db: D1Database, updateId: number): Promise<boolean> {
  const res = await db
    .prepare("INSERT OR IGNORE INTO telegram_updates(update_id) VALUES (?)")
    .bind(updateId)
    .run();
  return (res.meta.changes ?? 0) === 1;
}

export async function markUpdateProcessed(db: D1Database, updateId: number): Promise<void> {
  await db
    .prepare(
      "UPDATE telegram_updates SET processed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE update_id = ?",
    )
    .bind(updateId)
    .run();
}

export async function getOrCreateConversation(db: D1Database, chatId: number): Promise<number> {
  await db
    .prepare("INSERT OR IGNORE INTO conversations(chat_id) VALUES (?)")
    .bind(chatId)
    .run();
  const row = await db
    .prepare("SELECT id FROM conversations WHERE chat_id = ?")
    .bind(chatId)
    .first<{ id: number }>();
  if (!row) throw new Error("load conversation: no row after ensure");
  return row.id;
}

export async function appendMessage(
  db: D1Database,
  conversationId: number,
  role: string,
  text: string,
): Promise<void> {
  if (role !== "user" && role !== "assistant") throw new Error(`invalid message role ${role}`);
  await db
    .prepare("INSERT INTO messages(conversation_id, role, text) VALUES (?,?,?)")
    .bind(conversationId, role, text)
    .run();
}

/** Up to limit recent messages, chronological order. */
export async function recentMessages(
  db: D1Database,
  conversationId: number,
  limit: number,
): Promise<ChatMessage[]> {
  const res = await db
    .prepare("SELECT role, text FROM messages WHERE conversation_id = ? ORDER BY id DESC LIMIT ?")
    .bind(conversationId, limit)
    .all<ChatMessage>();
  return res.results.slice().reverse();
}

export async function recordTurnStat(db: D1Database, s: TurnStat): Promise<void> {
  await db
    .prepare(
      `INSERT INTO turn_stats(update_id, prompt_tokens, completion_tokens, total_tokens, model, latency_ms, error)
       VALUES (?,?,?,?,?,?,?)`,
    )
    .bind(
      s.updateId,
      s.promptTokens,
      s.completionTokens,
      s.totalTokens,
      s.model,
      s.latencyMs,
      s.error,
    )
    .run();
}

export async function openLoops(db: D1Database, chatId: number): Promise<OpenLoop[]> {
  const res = await db
    .prepare(
      `SELECT id, chat_id AS chatId, title, context, nudge_count AS nudgeCount, opened_at AS openedAt
       FROM open_loops WHERE chat_id = ? AND status = 'open' ORDER BY id`,
    )
    .bind(chatId)
    .all<OpenLoop>();
  return res.results;
}

/** Opens a loop unless the same title is already open in this chat. Returns row id. */
export async function openLoopOrExisting(
  db: D1Database,
  chatId: number,
  title: string,
  contextText: string,
): Promise<number> {
  const existing = await db
    .prepare("SELECT id FROM open_loops WHERE chat_id = ? AND status = 'open' AND title = ?")
    .bind(chatId, title)
    .first<{ id: number }>();
  if (existing) return existing.id;
  const res = await db
    .prepare("INSERT INTO open_loops(chat_id, title, context) VALUES (?,?,?)")
    .bind(chatId, title, contextText)
    .run();
  if (res.meta.last_row_id == null) throw new Error("open loop: missing row id");
  return res.meta.last_row_id;
}

/** Closes one loop, scoped to its chat so a bad close_id can't cross chats. */
export async function closeLoop(db: D1Database, id: number, chatId: number): Promise<void> {
  await db
    .prepare(
      `UPDATE open_loops SET status = 'closed', closed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
       WHERE id = ? AND chat_id = ? AND status = 'open'`,
    )
    .bind(id, chatId)
    .run();
}

export async function touchLoopNudged(db: D1Database, id: number): Promise<void> {
  await db
    .prepare(
      `UPDATE open_loops SET nudge_count = nudge_count + 1,
       last_nudged_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`,
    )
    .bind(id)
    .run();
}

/** Open loops stale enough to nudge. Cutoff is a UTC "YYYY-MM-DDTHH:mm:ss.sssZ" string. */
export async function dueLoops(
  db: D1Database,
  cutoff: string,
  maxNudges: number,
  limit: number,
): Promise<OpenLoop[]> {
  const res = await db
    .prepare(
      `SELECT id, chat_id AS chatId, title, context, nudge_count AS nudgeCount, opened_at AS openedAt
       FROM open_loops
       WHERE status = 'open' AND nudge_count < ?
         AND ((last_nudged_at IS NULL AND opened_at <= ?)
              OR last_nudged_at <= ?)
       ORDER BY opened_at LIMIT ?`,
    )
    .bind(maxNudges, cutoff, cutoff, limit)
    .all<OpenLoop>();
  return res.results;
}

export async function createReminder(
  db: D1Database,
  chatId: number,
  text: string,
  dueAt: Date,
): Promise<number> {
  const res = await db
    .prepare("INSERT INTO reminders(chat_id, text, due_at) VALUES (?,?,?)")
    .bind(chatId, text, dueAt.toISOString())
    .run();
  if (res.meta.last_row_id == null) throw new Error("create reminder: missing row id");
  return res.meta.last_row_id;
}

export async function dueReminders(db: D1Database, now: Date, limit: number): Promise<Reminder[]> {
  const res = await db
    .prepare(
      `SELECT id, chat_id AS chatId, text, due_at AS dueAt FROM reminders
       WHERE sent_at IS NULL AND due_at <= ? ORDER BY due_at LIMIT ?`,
    )
    .bind(now.toISOString(), limit)
    .all<Reminder>();
  return res.results;
}

export async function markReminderSent(db: D1Database, id: number): Promise<void> {
  await db
    .prepare("UPDATE reminders SET sent_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?")
    .bind(id)
    .run();
}

/**
 * Queues a proactive send. dedupeKey makes re-enqueues no-ops (INSERT OR
 * IGNORE); suggested keys: "nudge:<loop_id>:<date>", "reminder:<id>",
 * "briefing:<date>".
 */
export async function enqueueOutbox(
  db: D1Database,
  chatId: number,
  kind: string,
  refId: number | null,
  text: string,
  dedupeKey: string,
): Promise<void> {
  if (kind !== "nudge" && kind !== "reminder" && kind !== "briefing") {
    throw new Error(`invalid outbox kind ${kind}`);
  }
  await db
    .prepare(
      `INSERT OR IGNORE INTO outbox(chat_id, kind, ref_id, text, dedupe_key)
       VALUES (?,?,?,?,?)`,
    )
    .bind(chatId, kind, refId, text, dedupeKey)
    .run();
}

export async function pendingOutbox(db: D1Database, limit: number): Promise<OutboxMessage[]> {
  const res = await db
    .prepare(
      `SELECT id, chat_id AS chatId, kind, ref_id AS refId, text FROM outbox
       WHERE sent_at IS NULL AND claimed_at IS NULL ORDER BY id LIMIT ?`,
    )
    .bind(limit)
    .all<OutboxMessage>();
  return res.results;
}

/** Atomically owns an outbox row. False = someone else claimed it; skip. */
export async function claimOutbox(db: D1Database, id: number): Promise<boolean> {
  const res = await db
    .prepare(
      `UPDATE outbox SET claimed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
       WHERE id = ? AND claimed_at IS NULL AND sent_at IS NULL`,
    )
    .bind(id)
    .run();
  return (res.meta.changes ?? 0) === 1;
}

export async function markOutboxSent(db: D1Database, id: number): Promise<void> {
  await db
    .prepare("UPDATE outbox SET sent_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?")
    .bind(id)
    .run();
}

/** Returns a claimed row to the pool (deferred or failed send); else it sits forever. */
export async function releaseOutboxClaim(db: D1Database, id: number): Promise<void> {
  await db
    .prepare("UPDATE outbox SET claimed_at = NULL WHERE id = ? AND sent_at IS NULL")
    .bind(id)
    .run();
}

/** Counts a chat's delivered proactive sends since the given UTC timestamp string. */
export async function countOutboxSentSince(
  db: D1Database,
  chatId: number,
  since: string,
): Promise<number> {
  const row = await db
    .prepare("SELECT COUNT(*) AS n FROM outbox WHERE chat_id = ? AND sent_at IS NOT NULL AND sent_at >= ?")
    .bind(chatId, since)
    .first<{ n: number }>();
  return row?.n ?? 0;
}
