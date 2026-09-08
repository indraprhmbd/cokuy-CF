package storage

import (
	"context"
	"path/filepath"
	"testing"
)

func TestClaimUpdateDedupe(t *testing.T) {
	db, err := Open(filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	defer db.Close()
	ctx := context.Background()

	first, err := ClaimUpdate(ctx, db, 42)
	if err != nil || !first {
		t.Fatalf("first claim = %v, %v; want true, nil", first, err)
	}
	second, err := ClaimUpdate(ctx, db, 42)
	if err != nil || second {
		t.Fatalf("second claim = %v, %v; want false, nil", second, err)
	}
	if err := MarkUpdateProcessed(ctx, db, 42); err != nil {
		t.Fatalf("mark processed: %v", err)
	}
}

func TestConversationRoundTrip(t *testing.T) {
	db, err := Open(filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	defer db.Close()
	ctx := context.Background()

	conv, err := GetOrCreateConversation(ctx, db, 777)
	if err != nil {
		t.Fatalf("conversation: %v", err)
	}
	if err := AppendMessage(ctx, db, conv, "user", "halo"); err != nil {
		t.Fatalf("append user: %v", err)
	}
	if err := AppendMessage(ctx, db, conv, "assistant", "hai"); err != nil {
		t.Fatalf("append assistant: %v", err)
	}
	if err := AppendMessage(ctx, db, conv, "system", "x"); err == nil {
		t.Fatal("expected error for invalid role")
	}
	msgs, err := RecentMessages(ctx, db, conv, 10)
	if err != nil {
		t.Fatalf("recent: %v", err)
	}
	if len(msgs) != 2 || msgs[0].Text != "halo" || msgs[1].Text != "hai" {
		t.Fatalf("unexpected messages: %+v", msgs)
	}
	var journal string
	if err := db.QueryRow(`PRAGMA journal_mode`).Scan(&journal); err != nil {
		t.Fatalf("pragma journal_mode: %v", err)
	}
	if journal != "wal" {
		t.Fatalf("journal_mode = %q, want wal (DSN pragmas must apply)", journal)
	}
}
