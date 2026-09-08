package runtime

import (
	"context"
	"database/sql"
	"errors"
	"log/slog"
	"path/filepath"
	"testing"

	"cokuy/internal/config"
	"cokuy/internal/inference"
	"cokuy/internal/storage"
)

type fakeSender struct {
	sent []string
	fail bool
}

func (f *fakeSender) SendReply(_ int64, text string) error {
	if f.fail {
		return errors.New("send boom")
	}
	f.sent = append(f.sent, text)
	return nil
}

type stubLLM struct{ reply string }

func (s *stubLLM) Generate(_ context.Context, _ []inference.Message) (string, error) {
	return s.reply, nil
}

func testAgent(t *testing.T, sender *fakeSender) (*Agent, *sql.DB) {
	t.Helper()
	cfg := &config.Config{
		TelegramBotToken: "x",
		AllowedUserIDs:   map[int64]struct{}{7: {}},
		SQLitePath:       "test.db",
	}
	db, err := storage.Open(filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	t.Cleanup(func() { db.Close() })
	return New(cfg, db, &stubLLM{reply: "hai"}, sender, slog.Default()), db
}

func TestHandleUpdateHappyPath(t *testing.T) {
	sender := &fakeSender{}
	a, _ := testAgent(t, sender)
	ctx := context.Background()

	a.HandleUpdate(ctx, 1, 7, 100, "halo")
	if len(sender.sent) != 1 || sender.sent[0] != "hai" {
		t.Fatalf("sent = %v, want one 'hai' reply", sender.sent)
	}
	// Duplicate redelivery: no second side effect.
	a.HandleUpdate(ctx, 1, 7, 100, "halo")
	if len(sender.sent) != 1 {
		t.Fatalf("duplicate produced %d sends, want 1", len(sender.sent))
	}
}

func TestHandleUpdateDropsStranger(t *testing.T) {
	sender := &fakeSender{}
	a, _ := testAgent(t, sender)

	a.HandleUpdate(context.Background(), 2, 999, 100, "hallo?")
	if len(sender.sent) != 0 {
		t.Fatal("stranger must be silently dropped")
	}
}

func TestHandleUpdateSendFailureStaysUnprocessed(t *testing.T) {
	sender := &fakeSender{fail: true}
	a, db := testAgent(t, sender)
	ctx := context.Background()

	a.HandleUpdate(ctx, 3, 7, 100, "halo")
	var processed *string
	if err := db.QueryRow(`SELECT processed_at FROM telegram_updates WHERE update_id = 3`).Scan(&processed); err != nil {
		t.Fatalf("query: %v", err)
	}
	if processed != nil {
		t.Fatal("failed send must leave update unprocessed for retry")
	}
}
