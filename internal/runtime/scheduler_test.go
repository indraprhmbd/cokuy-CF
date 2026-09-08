package runtime

import (
	"context"
	"log/slog"
	"path/filepath"
	"testing"
	"time"

	"cokuy/internal/storage"
)

type stubStructured struct {
	reply string
	calls int
}

func (s *stubStructured) GenerateStructured(_ context.Context, _, _ string) (string, error) {
	s.calls++
	return s.reply, nil
}

func testTickDB(t *testing.T) (*senderRec, *stubStructured) {
	t.Helper()
	return &senderRec{}, &stubStructured{reply: "eh, udah beres belum?"}
}

type senderRec struct {
	sent []string
}

func (s *senderRec) SendReply(_ int64, text string) error {
	s.sent = append(s.sent, text)
	return nil
}

func wibAt(h int) time.Time {
	return time.Date(2026, 9, 9, h, 0, 0, 0, wibZone)
}

func TestTickReminderDelivered(t *testing.T) {
	db, err := storage.Open(filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	defer db.Close()
	ctx := context.Background()
	bot, llm := testTickDB(t)

	past := wibAt(8).Add(-time.Hour)
	if _, err := storage.CreateReminder(ctx, db, 1, "call mom", past); err != nil {
		t.Fatalf("create reminder: %v", err)
	}
	Tick(ctx, db, bot, llm, slog.Default(), wibAt(9))

	if len(bot.sent) != 1 || bot.sent[0] != "Pengingat: call mom" {
		t.Fatalf("sent = %q; want reminder text", bot.sent)
	}
	due, err := storage.DueReminders(ctx, db, wibAt(9), 10)
	if err != nil || len(due) != 0 {
		t.Fatalf("due after tick = %+v, %v; want empty", due, err)
	}
}

func TestTickQuietHoursDefers(t *testing.T) {
	db, err := storage.Open(filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	defer db.Close()
	ctx := context.Background()
	bot, llm := testTickDB(t)

	if _, err := storage.CreateReminder(ctx, db, 1, "late thing", wibAt(23).Add(-time.Hour)); err != nil {
		t.Fatalf("create reminder: %v", err)
	}
	Tick(ctx, db, bot, llm, slog.Default(), wibAt(23))

	if len(bot.sent) != 0 {
		t.Fatalf("sent during quiet = %q; want none", bot.sent)
	}
	// Row released back to pending, not stuck claimed.
	pending, err := storage.PendingOutbox(ctx, db, 10)
	if err != nil || len(pending) != 1 {
		t.Fatalf("pending after quiet tick = %+v, %v; want 1", pending, err)
	}
	// Morning flush delivers it.
	Tick(ctx, db, bot, llm, slog.Default(), wibAt(7))
	if len(bot.sent) != 1 {
		t.Fatalf("sent after quiet = %q; want 1", bot.sent)
	}
}

func TestTickDailyCap(t *testing.T) {
	db, err := storage.Open(filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	defer db.Close()
	ctx := context.Background()
	bot, llm := testTickDB(t)

	for i := 0; i < maxProactivePerDay+1; i++ {
		due := wibAt(9).Add(-time.Hour)
		if _, err := storage.CreateReminder(ctx, db, 1, "r", due); err != nil {
			t.Fatalf("create reminder: %v", err)
		}
	}
	Tick(ctx, db, bot, llm, slog.Default(), wibAt(9))

	if len(bot.sent) != maxProactivePerDay {
		t.Fatalf("sent = %d; want cap %d", len(bot.sent), maxProactivePerDay)
	}
	pending, err := storage.PendingOutbox(ctx, db, 10)
	if err != nil || len(pending) != 1 {
		t.Fatalf("pending after cap = %+v, %v; want 1 deferred", pending, err)
	}
}

func TestTickNudgeDraftedAndLogged(t *testing.T) {
	db, err := storage.Open(filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	defer db.Close()
	ctx := context.Background()
	bot, llm := testTickDB(t)

	if _, err := storage.OpenLoopOrExisting(ctx, db, 1, "visa docs", "passport scan"); err != nil {
		t.Fatalf("open loop: %v", err)
	}
	// 25h+ after opening (bumped out of quiet hours): stale, so one tick
	// drafts and delivers.
	tickAt := time.Now().In(wibZone).Add(25 * time.Hour)
	for inQuietHours(tickAt) {
		tickAt = tickAt.Add(time.Hour)
	}
	Tick(ctx, db, bot, llm, slog.Default(), tickAt)

	if llm.calls != 1 {
		t.Fatalf("llm calls = %d; want 1", llm.calls)
	}
	if len(bot.sent) != 1 {
		t.Fatalf("sent = %q; want nudge", bot.sent)
	}
	loops, err := storage.OpenLoops(ctx, db, 1)
	if err != nil || len(loops) != 1 || loops[0].NudgeCount != 1 {
		t.Fatalf("loops = %+v, %v; want nudge_count 1", loops, err)
	}
}

func TestInQuietHours(t *testing.T) {
	for h, want := range map[int]bool{21: false, 22: true, 23: true, 0: true, 6: true, 7: false, 12: false} {
		if got := inQuietHours(wibAt(h)); got != want {
			t.Fatalf("hour %d: got %v want %v", h, got, want)
		}
	}
}
