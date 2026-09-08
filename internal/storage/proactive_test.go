package storage

import (
	"context"
	"path/filepath"
	"testing"
	"time"
)

func TestLoopDedupeAndClose(t *testing.T) {
	db, err := Open(filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	defer db.Close()
	ctx := context.Background()

	id1, err := OpenLoopOrExisting(ctx, db, 1, "thesis draft", "bab 3")
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	id2, err := OpenLoopOrExisting(ctx, db, 1, "thesis draft", "bab 3 updated")
	if err != nil {
		t.Fatalf("reopen: %v", err)
	}
	if id1 != id2 {
		t.Fatalf("dedupe failed: %d != %d", id1, id2)
	}
	loops, err := OpenLoops(ctx, db, 1)
	if err != nil || len(loops) != 1 {
		t.Fatalf("open loops = %+v, %v; want 1 row", loops, err)
	}
	if err := CloseLoop(ctx, db, id1, 1); err != nil {
		t.Fatalf("close: %v", err)
	}
	// Closing another chat's loop id must not touch this chat: reopening
	// the same title creates a fresh row.
	id3, err := OpenLoopOrExisting(ctx, db, 1, "thesis draft", "again")
	if err != nil {
		t.Fatalf("reopen after close: %v", err)
	}
	if id3 == id1 {
		t.Fatal("expected new row after close")
	}
	if err := CloseLoop(ctx, db, id3, 999); err != nil {
		t.Fatalf("cross-chat close err: %v", err)
	}
	loops, err = OpenLoops(ctx, db, 1)
	if err != nil || len(loops) != 1 || loops[0].ID != id3 {
		t.Fatalf("cross-chat close leaked: %+v, %v", loops, err)
	}
}

func TestRemindersDue(t *testing.T) {
	db, err := Open(filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	defer db.Close()
	ctx := context.Background()
	now := time.Now()

	if _, err := CreateReminder(ctx, db, 1, "call mom", now.Add(-time.Minute)); err != nil {
		t.Fatalf("create overdue: %v", err)
	}
	if _, err := CreateReminder(ctx, db, 1, "later thing", now.Add(time.Hour)); err != nil {
		t.Fatalf("create future: %v", err)
	}
	due, err := DueReminders(ctx, db, now, 10)
	if err != nil || len(due) != 1 || due[0].Text != "call mom" {
		t.Fatalf("due = %+v, %v; want only overdue", due, err)
	}
	if err := MarkReminderSent(ctx, db, due[0].ID); err != nil {
		t.Fatalf("mark sent: %v", err)
	}
	due, err = DueReminders(ctx, db, now, 10)
	if err != nil || len(due) != 0 {
		t.Fatalf("due after send = %+v, %v; want empty", due, err)
	}
}

func TestOutboxReleaseAndCapCount(t *testing.T) {
	db, err := Open(filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	defer db.Close()
	ctx := context.Background()

	if err := EnqueueOutbox(ctx, db, 1, "briefing", nil, "morning", "b:2026-09-09"); err != nil {
		t.Fatalf("enqueue: %v", err)
	}
	pending, err := PendingOutbox(ctx, db, 10)
	if err != nil || len(pending) != 1 {
		t.Fatalf("pending = %+v, %v", pending, err)
	}
	id := pending[0].ID
	if ok, err := ClaimOutbox(ctx, db, id); err != nil || !ok {
		t.Fatalf("claim = %v, %v", ok, err)
	}
	if err := ReleaseOutboxClaim(ctx, db, id); err != nil {
		t.Fatalf("release: %v", err)
	}
	pending, err = PendingOutbox(ctx, db, 10)
	if err != nil || len(pending) != 1 {
		t.Fatalf("pending after release = %+v, %v; want 1", pending, err)
	}
	n, err := CountOutboxSentSince(ctx, db, 1, "2000-01-01T00:00:00.000Z")
	if err != nil || n != 0 {
		t.Fatalf("count before send = %d, %v; want 0", n, err)
	}
	if ok, err := ClaimOutbox(ctx, db, id); err != nil || !ok {
		t.Fatalf("reclaim = %v, %v", ok, err)
	}
	if err := MarkOutboxSent(ctx, db, id); err != nil {
		t.Fatalf("mark sent: %v", err)
	}
	n, err = CountOutboxSentSince(ctx, db, 1, "2000-01-01T00:00:00.000Z")
	if err != nil || n != 1 {
		t.Fatalf("count after send = %d, %v; want 1", n, err)
	}
	n, err = CountOutboxSentSince(ctx, db, 2, "2000-01-01T00:00:00.000Z")
	if err != nil || n != 0 {
		t.Fatalf("other chat count = %d, %v; want 0", n, err)
	}
}

func TestOutboxClaimSend(t *testing.T) {
	db, err := Open(filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	defer db.Close()
	ctx := context.Background()

	if err := EnqueueOutbox(ctx, db, 1, "nudge", nil, "hey", "nudge:5:2026-09-09"); err != nil {
		t.Fatalf("enqueue: %v", err)
	}
	// Same dedupe key is a no-op.
	if err := EnqueueOutbox(ctx, db, 1, "nudge", nil, "hey again", "nudge:5:2026-09-09"); err != nil {
		t.Fatalf("re-enqueue: %v", err)
	}
	if err := EnqueueOutbox(ctx, db, 1, "bogus", nil, "x", "k2"); err == nil {
		t.Fatal("expected error for invalid kind")
	}
	pending, err := PendingOutbox(ctx, db, 10)
	if err != nil || len(pending) != 1 {
		t.Fatalf("pending = %+v, %v; want 1 row", pending, err)
	}
	id := pending[0].ID
	claimed, err := ClaimOutbox(ctx, db, id)
	if err != nil || !claimed {
		t.Fatalf("first claim = %v, %v; want true", claimed, err)
	}
	claimed, err = ClaimOutbox(ctx, db, id)
	if err != nil || claimed {
		t.Fatalf("second claim = %v, %v; want false", claimed, err)
	}
	pending, err = PendingOutbox(ctx, db, 10)
	if err != nil || len(pending) != 0 {
		t.Fatalf("pending after claim = %+v, %v; want empty", pending, err)
	}
	if err := MarkOutboxSent(ctx, db, id); err != nil {
		t.Fatalf("mark sent: %v", err)
	}
}
