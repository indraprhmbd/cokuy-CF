package storage

import (
	"context"
	"database/sql"
	"fmt"
	"time"
)

// This file owns Sprint A proactive state: open loops, reminders, and the
// outbox queue. Outbox delivery follows the same claim-before-effect
// pattern as telegram_updates: ClaimOutbox owns a row, MarkOutboxSent
// closes it, so redeliveries and restarts never double-send.

// OpenLoop is one tracked unfinished thread in a chat.
type OpenLoop struct {
	ID         int64
	ChatID     int64
	Title      string
	Context    string
	NudgeCount int64
	OpenedAt   string
}

// OpenLoops returns a chat's open loops, oldest first.
func OpenLoops(ctx context.Context, db *sql.DB, chatID int64) ([]OpenLoop, error) {
	rows, err := db.QueryContext(ctx,
		`SELECT id, chat_id, title, context, nudge_count, opened_at
		 FROM open_loops WHERE chat_id = ? AND status = 'open' ORDER BY id`,
		chatID)
	if err != nil {
		return nil, fmt.Errorf("open loops: %w", err)
	}
	defer rows.Close()
	var out []OpenLoop
	for rows.Next() {
		var l OpenLoop
		if err := rows.Scan(&l.ID, &l.ChatID, &l.Title, &l.Context, &l.NudgeCount, &l.OpenedAt); err != nil {
			return nil, fmt.Errorf("scan open loop: %w", err)
		}
		out = append(out, l)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate open loops: %w", err)
	}
	return out, nil
}

// OpenLoopOrExisting opens a loop unless the same title is already open in
// this chat. Detector re-emits continuing threads every turn, so title
// dedupe is what keeps one thread one row. Returns the row id.
func OpenLoopOrExisting(ctx context.Context, db *sql.DB, chatID int64, title, contextText string) (int64, error) {
	var id int64
	err := db.QueryRowContext(ctx,
		`SELECT id FROM open_loops WHERE chat_id = ? AND status = 'open' AND title = ?`,
		chatID, title).Scan(&id)
	if err == nil {
		return id, nil
	}
	if err != sql.ErrNoRows {
		return 0, fmt.Errorf("find open loop: %w", err)
	}
	res, err := db.ExecContext(ctx,
		`INSERT INTO open_loops(chat_id, title, context) VALUES (?,?,?)`,
		chatID, title, contextText)
	if err != nil {
		return 0, fmt.Errorf("open loop: %w", err)
	}
	id, err = res.LastInsertId()
	if err != nil {
		return 0, fmt.Errorf("open loop id: %w", err)
	}
	return id, nil
}

// CloseLoop closes one loop, scoped to its chat so a bad detector close_id
// can never touch another chat's state.
func CloseLoop(ctx context.Context, db *sql.DB, id, chatID int64) error {
	if _, err := db.ExecContext(ctx,
		`UPDATE open_loops SET status = 'closed', closed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
		 WHERE id = ? AND chat_id = ? AND status = 'open'`,
		id, chatID); err != nil {
		return fmt.Errorf("close loop: %w", err)
	}
	return nil
}

// TouchLoopNudged records that a nudge was sent for a loop.
func TouchLoopNudged(ctx context.Context, db *sql.DB, id int64) error {
	if _, err := db.ExecContext(ctx,
		`UPDATE open_loops SET nudge_count = nudge_count + 1,
		 last_nudged_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`,
		id); err != nil {
		return fmt.Errorf("touch loop nudged: %w", err)
	}
	return nil
}

// DueLoops returns open loops stale enough to nudge: never nudged and
// opened before cutoff, or last nudged before cutoff, and under the nudge
// cap. Cutoff is a strftime-format UTC string from the caller.
func DueLoops(ctx context.Context, db *sql.DB, cutoff string, maxNudges int, limit int) ([]OpenLoop, error) {
	rows, err := db.QueryContext(ctx,
		`SELECT id, chat_id, title, context, nudge_count, opened_at
		 FROM open_loops
		 WHERE status = 'open' AND nudge_count < ?
		   AND ((last_nudged_at IS NULL AND opened_at <= ?)
		        OR last_nudged_at <= ?)
		 ORDER BY opened_at LIMIT ?`,
		maxNudges, cutoff, cutoff, limit)
	if err != nil {
		return nil, fmt.Errorf("due loops: %w", err)
	}
	defer rows.Close()
	var out []OpenLoop
	for rows.Next() {
		var l OpenLoop
		if err := rows.Scan(&l.ID, &l.ChatID, &l.Title, &l.Context, &l.NudgeCount, &l.OpenedAt); err != nil {
			return nil, fmt.Errorf("scan due loop: %w", err)
		}
		out = append(out, l)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate due loops: %w", err)
	}
	return out, nil
}

// Reminder is one pending nudge-me-later.
type Reminder struct {
	ID     int64
	ChatID int64
	Text   string
	DueAt  string
}

// ts formats a time to match the strftime '%Y-%m-%dT%H:%M:%fZ' rows so
// lexicographic comparisons stay correct.
func ts(t time.Time) string {
	return t.UTC().Format("2006-01-02T15:04:05.000Z")
}

// CreateReminder stores a reminder due at dueAt.
func CreateReminder(ctx context.Context, db *sql.DB, chatID int64, text string, dueAt time.Time) (int64, error) {
	res, err := db.ExecContext(ctx,
		`INSERT INTO reminders(chat_id, text, due_at) VALUES (?,?,?)`,
		chatID, text, ts(dueAt))
	if err != nil {
		return 0, fmt.Errorf("create reminder: %w", err)
	}
	id, err := res.LastInsertId()
	if err != nil {
		return 0, fmt.Errorf("reminder id: %w", err)
	}
	return id, nil
}

// DueReminders returns unsent reminders due at or before now, oldest first.
func DueReminders(ctx context.Context, db *sql.DB, now time.Time, limit int) ([]Reminder, error) {
	rows, err := db.QueryContext(ctx,
		`SELECT id, chat_id, text, due_at FROM reminders
		 WHERE sent_at IS NULL AND due_at <= ? ORDER BY due_at LIMIT ?`,
		ts(now), limit)
	if err != nil {
		return nil, fmt.Errorf("due reminders: %w", err)
	}
	defer rows.Close()
	var out []Reminder
	for rows.Next() {
		var r Reminder
		if err := rows.Scan(&r.ID, &r.ChatID, &r.Text, &r.DueAt); err != nil {
			return nil, fmt.Errorf("scan due reminder: %w", err)
		}
		out = append(out, r)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate due reminders: %w", err)
	}
	return out, nil
}

// MarkReminderSent closes a reminder so it never fires twice.
func MarkReminderSent(ctx context.Context, db *sql.DB, id int64) error {
	if _, err := db.ExecContext(ctx,
		`UPDATE reminders SET sent_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`,
		id); err != nil {
		return fmt.Errorf("mark reminder sent: %w", err)
	}
	return nil
}

// OutboxMessage is one queued proactive send.
type OutboxMessage struct {
	ID     int64
	ChatID int64
	Kind   string
	RefID  *int64
	Text   string
}

// EnqueueOutbox queues a proactive send. dedupeKey makes re-enqueues of the
// same event no-ops (INSERT OR IGNORE); suggested keys:
// "nudge:<loop_id>:<date>", "reminder:<reminder_id>", "briefing:<date>".
func EnqueueOutbox(ctx context.Context, db *sql.DB, chatID int64, kind string, refID *int64, text, dedupeKey string) error {
	if kind != "nudge" && kind != "reminder" && kind != "briefing" {
		return fmt.Errorf("invalid outbox kind %q", kind)
	}
	var ref any
	if refID != nil {
		ref = *refID
	}
	if _, err := db.ExecContext(ctx,
		`INSERT OR IGNORE INTO outbox(chat_id, kind, ref_id, text, dedupe_key)
		 VALUES (?,?,?,?,?)`,
		chatID, kind, ref, text, dedupeKey); err != nil {
		return fmt.Errorf("enqueue outbox: %w", err)
	}
	return nil
}

// PendingOutbox returns unclaimed, unsent rows, oldest first.
func PendingOutbox(ctx context.Context, db *sql.DB, limit int) ([]OutboxMessage, error) {
	rows, err := db.QueryContext(ctx,
		`SELECT id, chat_id, kind, ref_id, text FROM outbox
		 WHERE sent_at IS NULL AND claimed_at IS NULL ORDER BY id LIMIT ?`,
		limit)
	if err != nil {
		return nil, fmt.Errorf("pending outbox: %w", err)
	}
	defer rows.Close()
	var out []OutboxMessage
	for rows.Next() {
		var m OutboxMessage
		var ref sql.NullInt64
		if err := rows.Scan(&m.ID, &m.ChatID, &m.Kind, &ref, &m.Text); err != nil {
			return nil, fmt.Errorf("scan outbox: %w", err)
		}
		if ref.Valid {
			m.RefID = &ref.Int64
		}
		out = append(out, m)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate outbox: %w", err)
	}
	return out, nil
}

// ClaimOutbox atomically owns an outbox row. False means another worker
// (or a previous tick) claimed it first; skip without side effects.
func ClaimOutbox(ctx context.Context, db *sql.DB, id int64) (bool, error) {
	res, err := db.ExecContext(ctx,
		`UPDATE outbox SET claimed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
		 WHERE id = ? AND claimed_at IS NULL AND sent_at IS NULL`,
		id)
	if err != nil {
		return false, fmt.Errorf("claim outbox: %w", err)
	}
	n, err := res.RowsAffected()
	if err != nil {
		return false, fmt.Errorf("claim outbox rows: %w", err)
	}
	return n == 1, nil
}

// MarkOutboxSent closes an outbox row after successful delivery.
func MarkOutboxSent(ctx context.Context, db *sql.DB, id int64) error {
	if _, err := db.ExecContext(ctx,
		`UPDATE outbox SET sent_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`,
		id); err != nil {
		return fmt.Errorf("mark outbox sent: %w", err)
	}
	return nil
}

// ReleaseOutboxClaim returns a claimed row to the pending pool so a later
// tick retries it. Used when delivery is deferred (quiet hours, daily cap)
// or the send failed: a claimed row would otherwise sit forever.
func ReleaseOutboxClaim(ctx context.Context, db *sql.DB, id int64) error {
	if _, err := db.ExecContext(ctx,
		`UPDATE outbox SET claimed_at = NULL WHERE id = ? AND sent_at IS NULL`,
		id); err != nil {
		return fmt.Errorf("release outbox claim: %w", err)
	}
	return nil
}

// CountOutboxSentSince counts a chat's delivered proactive sends since the
// given strftime-format UTC timestamp. Backs the daily per-chat cap.
func CountOutboxSentSince(ctx context.Context, db *sql.DB, chatID int64, since string) (int, error) {
	var n int
	if err := db.QueryRowContext(ctx,
		`SELECT COUNT(*) FROM outbox WHERE chat_id = ? AND sent_at IS NOT NULL AND sent_at >= ?`,
		chatID, since).Scan(&n); err != nil {
		return 0, fmt.Errorf("count outbox sent: %w", err)
	}
	return n, nil
}
