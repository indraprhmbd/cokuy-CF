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
	if _, err := db.ExecContext(ctx, migration001); err != nil {
		return fmt.Errorf("apply migration 001: %w", err)
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
