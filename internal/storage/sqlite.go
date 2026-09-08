// Package storage owns Cokuy's durable SQLite state.
//
// Best-practice notes (modernc.org/sqlite, pure Go, CGO_ENABLED=0):
//   - PRAGMAs travel in the DSN via _pragma= so EVERY pooled connection gets
//     them; a one-time db.Exec("PRAGMA ...") only touches one connection.
//   - WAL lets readers proceed alongside the single writer; it is unsafe on
//     NFS/SMB — this database must live on local disk.
//   - MaxOpenConns(1) serializes writers in the Go pool so contention shows
//     up as pool waits instead of SQLITE_BUSY errors.
package storage

import (
	"context"
	"database/sql"
	_ "embed"
	"fmt"
	"time"

	_ "modernc.org/sqlite"
)

//go:embed migrations/001_init.sql
var migration001 string

//go:embed migrations/002_turn_stats.sql
var migration002 string

// Open opens the SQLite database at path, applies required PRAGMAs per
// connection via the DSN, verifies connectivity, and runs migrations.
func Open(path string) (*sql.DB, error) {
	dsn := fmt.Sprintf(
		"file:%s?_pragma=journal_mode(WAL)&_pragma=busy_timeout(5000)&_pragma=synchronous(NORMAL)&_pragma=foreign_keys(ON)",
		path,
	)
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, fmt.Errorf("open sqlite: %w", err)
	}
	// SQLite has a single writer; serialize through one pooled connection.
	db.SetMaxOpenConns(1)
	db.SetMaxIdleConns(1)
	db.SetConnMaxLifetime(0)

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := db.PingContext(ctx); err != nil {
		db.Close()
		return nil, fmt.Errorf("ping sqlite: %w", err)
	}
	if err := migrate(ctx, db); err != nil {
		db.Close()
		return nil, err
	}
	return db, nil
}

func migrate(ctx context.Context, db *sql.DB) error {
	// Migrations are idempotent (IF NOT EXISTS), so applying in order is
	// safe on every boot without a version-tracking table.
	for i, m := range []string{migration001, migration002} {
		if _, err := db.ExecContext(ctx, m); err != nil {
			return fmt.Errorf("apply migration %03d: %w", i+1, err)
		}
	}
	return nil
}

// ClaimUpdate atomically records a Telegram update_id. It returns true when
// this process is the first to claim it; a duplicate returns false and must
// be skipped without side effects (idempotent retry / redelivery safety).
func ClaimUpdate(ctx context.Context, db *sql.DB, updateID int64) (bool, error) {
	res, err := db.ExecContext(ctx,
		`INSERT OR IGNORE INTO telegram_updates(update_id) VALUES (?)`, updateID)
	if err != nil {
		return false, fmt.Errorf("claim update: %w", err)
	}
	n, err := res.RowsAffected()
	if err != nil {
		return false, fmt.Errorf("claim update rows: %w", err)
	}
	return n == 1, nil
}

// MarkUpdateProcessed records that an update's turn completed.
func MarkUpdateProcessed(ctx context.Context, db *sql.DB, updateID int64) error {
	if _, err := db.ExecContext(ctx,
		`UPDATE telegram_updates SET processed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE update_id = ?`,
		updateID); err != nil {
		return fmt.Errorf("mark update processed: %w", err)
	}
	return nil
}

// GetOrCreateConversation returns the conversation row id for a chat.
func GetOrCreateConversation(ctx context.Context, db *sql.DB, chatID int64) (int64, error) {
	if _, err := db.ExecContext(ctx,
		`INSERT OR IGNORE INTO conversations(chat_id) VALUES (?)`, chatID); err != nil {
		return 0, fmt.Errorf("ensure conversation: %w", err)
	}
	var id int64
	if err := db.QueryRowContext(ctx,
		`SELECT id FROM conversations WHERE chat_id = ?`, chatID).Scan(&id); err != nil {
		return 0, fmt.Errorf("load conversation: %w", err)
	}
	return id, nil
}

// AppendMessage persists one user or assistant message. Role is constrained
// by CHECK(role IN ('user','assistant')); model output is stored as data,
// never executed.
func AppendMessage(ctx context.Context, db *sql.DB, conversationID int64, role, text string) error {
	if role != "user" && role != "assistant" {
		return fmt.Errorf("invalid message role %q", role)
	}
	if _, err := db.ExecContext(ctx,
		`INSERT INTO messages(conversation_id, role, text) VALUES (?,?,?)`,
		conversationID, role, text); err != nil {
		return fmt.Errorf("append message: %w", err)
	}
	return nil
}

// RecentMessages returns up to limit recent messages in chronological order.
func RecentMessages(ctx context.Context, db *sql.DB, conversationID int64, limit int) ([]Message, error) {
	rows, err := db.QueryContext(ctx,
		`SELECT role, text FROM messages WHERE conversation_id = ? ORDER BY id DESC LIMIT ?`,
		conversationID, limit)
	if err != nil {
		return nil, fmt.Errorf("recent messages: %w", err)
	}
	defer rows.Close()
	var out []Message
	for rows.Next() {
		var m Message
		if err := rows.Scan(&m.Role, &m.Text); err != nil {
			return nil, fmt.Errorf("scan message: %w", err)
		}
		out = append(out, m)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate messages: %w", err)
	}
	// Reverse into chronological order.
	for i, j := 0, len(out)-1; i < j; i, j = i+1, j-1 {
		out[i], out[j] = out[j], out[i]
	}
	return out, nil
}

// Message is one persisted chat message.
type Message struct {
	Role string
	Text string
}

// TurnStat is one recorded agent turn, success or failure. Error is empty
// on success; token counts are zero when the model was never reached.
type TurnStat struct {
	UpdateID         int64
	PromptTokens     int64
	CompletionTokens int64
	TotalTokens      int64
	Model            string
	LatencyMs        int64
	Error            string
}

// RecordTurnStat persists one turn's stats for the monitoring dashboard.
func RecordTurnStat(ctx context.Context, db *sql.DB, s TurnStat) error {
	if _, err := db.ExecContext(ctx,
		`INSERT INTO turn_stats(update_id, prompt_tokens, completion_tokens, total_tokens, model, latency_ms, error)
		 VALUES (?,?,?,?,?,?,?)`,
		s.UpdateID, s.PromptTokens, s.CompletionTokens, s.TotalTokens, s.Model, s.LatencyMs, s.Error); err != nil {
		return fmt.Errorf("record turn stat: %w", err)
	}
	return nil
}

// DayUsage aggregates turn stats per UTC day, newest last. CostUSD is
// filled by the metrics layer from current pricing, not stored.
type DayUsage struct {
	Day              string  `json:"day"`
	Turns            int64   `json:"turns"`
	PromptTokens     int64   `json:"prompt_tokens"`
	CompletionTokens int64   `json:"completion_tokens"`
	TotalTokens      int64   `json:"total_tokens"`
	Errors           int64   `json:"errors"`
	CostUSD          float64 `json:"cost_usd"`
}

// DailyUsage returns per-day aggregates for the last days days.
func DailyUsage(ctx context.Context, db *sql.DB, days int) ([]DayUsage, error) {
	rows, err := db.QueryContext(ctx,
		`SELECT substr(created_at, 1, 10) AS day,
			COUNT(*),
			COALESCE(SUM(prompt_tokens),0),
			COALESCE(SUM(completion_tokens),0),
			COALESCE(SUM(total_tokens),0),
			SUM(CASE WHEN error <> '' THEN 1 ELSE 0 END)
		 FROM turn_stats
		 WHERE created_at >= strftime('%Y-%m-%dT%H:%M:%fZ','now', ?)
		 GROUP BY day ORDER BY day`,
		fmt.Sprintf("-%d days", days))
	if err != nil {
		return nil, fmt.Errorf("daily usage: %w", err)
	}
	defer rows.Close()
	var out []DayUsage
	for rows.Next() {
		var d DayUsage
		if err := rows.Scan(&d.Day, &d.Turns, &d.PromptTokens, &d.CompletionTokens, &d.TotalTokens, &d.Errors); err != nil {
			return nil, fmt.Errorf("scan day usage: %w", err)
		}
		out = append(out, d)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate day usage: %w", err)
	}
	return out, nil
}

// Totals aggregates lifetime turn stats. CostUSD is filled by the
// metrics layer from current pricing, not stored.
type Totals struct {
	Turns            int64   `json:"turns"`
	PromptTokens     int64   `json:"prompt_tokens"`
	CompletionTokens int64   `json:"completion_tokens"`
	TotalTokens      int64   `json:"total_tokens"`
	Errors           int64   `json:"errors"`
	CostUSD          float64 `json:"cost_usd"`
}

// LifetimeTotals returns lifetime aggregates (zero rows when empty).
func LifetimeTotals(ctx context.Context, db *sql.DB) (Totals, error) {
	var t Totals
	if err := db.QueryRowContext(ctx,
		`SELECT COUNT(*),
			COALESCE(SUM(prompt_tokens),0),
			COALESCE(SUM(completion_tokens),0),
			COALESCE(SUM(total_tokens),0),
			COALESCE(SUM(CASE WHEN error <> '' THEN 1 ELSE 0 END),0)
		 FROM turn_stats`).Scan(&t.Turns, &t.PromptTokens, &t.CompletionTokens, &t.TotalTokens, &t.Errors); err != nil {
		return Totals{}, fmt.Errorf("lifetime totals: %w", err)
	}
	return t, nil
}

// TurnError is one failed turn for the dashboard error log.
type TurnError struct {
	UpdateID  int64  `json:"update_id"`
	Model     string `json:"model"`
	Error     string `json:"error"`
	CreatedAt string `json:"created_at"`
}

// RecentErrors returns the newest failed turns, newest first.
func RecentErrors(ctx context.Context, db *sql.DB, limit int) ([]TurnError, error) {
	rows, err := db.QueryContext(ctx,
		`SELECT update_id, model, error, created_at FROM turn_stats
		 WHERE error <> '' ORDER BY update_id DESC LIMIT ?`, limit)
	if err != nil {
		return nil, fmt.Errorf("recent errors: %w", err)
	}
	defer rows.Close()
	var out []TurnError
	for rows.Next() {
		var e TurnError
		if err := rows.Scan(&e.UpdateID, &e.Model, &e.Error, &e.CreatedAt); err != nil {
			return nil, fmt.Errorf("scan turn error: %w", err)
		}
		out = append(out, e)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate turn errors: %w", err)
	}
	return out, nil
}

// ConversationInfo summarizes one conversation for the dashboard.
type ConversationInfo struct {
	ChatID       int64  `json:"chat_id"`
	Messages     int64  `json:"messages"`
	LastActivity string `json:"last_activity"`
}

// ListConversations returns per-chat summaries, most recently active first.
func ListConversations(ctx context.Context, db *sql.DB) ([]ConversationInfo, error) {
	rows, err := db.QueryContext(ctx,
		`SELECT c.chat_id, COUNT(m.id), COALESCE(MAX(m.created_at), c.created_at)
		 FROM conversations c LEFT JOIN messages m ON m.conversation_id = c.id
		 GROUP BY c.id ORDER BY COALESCE(MAX(m.created_at), c.created_at) DESC`)
	if err != nil {
		return nil, fmt.Errorf("list conversations: %w", err)
	}
	defer rows.Close()
	var out []ConversationInfo
	for rows.Next() {
		var c ConversationInfo
		if err := rows.Scan(&c.ChatID, &c.Messages, &c.LastActivity); err != nil {
			return nil, fmt.Errorf("scan conversation: %w", err)
		}
		out = append(out, c)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate conversations: %w", err)
	}
	return out, nil
}
