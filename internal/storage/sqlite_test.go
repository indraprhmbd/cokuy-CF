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

func TestTurnStatsRoundTrip(t *testing.T) {
	db, err := Open(filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	defer db.Close()
	ctx := context.Background()

	if _, err := ClaimUpdate(ctx, db, 7); err != nil {
		t.Fatalf("claim: %v", err)
	}
	if err := RecordTurnStat(ctx, db, TurnStat{
		UpdateID: 7, PromptTokens: 100, CompletionTokens: 20, TotalTokens: 120,
		Model: "m", LatencyMs: 500,
	}); err != nil {
		t.Fatalf("record success: %v", err)
	}
	if _, err := ClaimUpdate(ctx, db, 8); err != nil {
		t.Fatalf("claim: %v", err)
	}
	if err := RecordTurnStat(ctx, db, TurnStat{
		UpdateID: 8, Model: "m", LatencyMs: 1000, Error: "boom",
	}); err != nil {
		t.Fatalf("record failure: %v", err)
	}

	tot, err := LifetimeTotals(ctx, db)
	if err != nil {
		t.Fatalf("totals: %v", err)
	}
	if tot.Turns != 2 || tot.TotalTokens != 120 || tot.Errors != 1 {
		t.Fatalf("unexpected totals: %+v", tot)
	}
	daily, err := DailyUsage(ctx, db, 30)
	if err != nil {
		t.Fatalf("daily: %v", err)
	}
	if len(daily) != 1 || daily[0].Turns != 2 || daily[0].Errors != 1 {
		t.Fatalf("unexpected daily: %+v", daily)
	}
	errs, err := RecentErrors(ctx, db, 10)
	if err != nil {
		t.Fatalf("errors: %v", err)
	}
	if len(errs) != 1 || errs[0].UpdateID != 8 || errs[0].Error != "boom" {
		t.Fatalf("unexpected errors: %+v", errs)
	}
}
