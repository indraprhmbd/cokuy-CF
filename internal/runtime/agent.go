// Package runtime is Cokuy's bounded agent turn:
//
//	receive update -> allowlist -> claim update_id -> load minimal state ->
//	call model -> validate writes -> persist -> reply -> mark processed.
//
// Explicit bounds: one LLM call per update, 20-message history window,
// 4000-char input cap, provider-level timeout. No tool execution in v0.1,
// so model output can only become reply text, never actions.
package runtime

import (
	"context"
	"database/sql"
	"log/slog"
	"strings"
	"unicode/utf8"

	"cokuy/internal/config"
	"cokuy/internal/inference"
	"cokuy/internal/storage"
)

const (
	// historyLimit bounds the context sent to the model per turn.
	historyLimit = 20
	// maxInputChars bounds inbound text before persistence + inference.
	maxInputChars = 4000
	// maxReplyChars respects Telegram's 4096-char message cap with margin.
	maxReplyChars = 4000
)

// Sender delivers reply text to a chat (transport.Bot in production,
// a fake in tests).
type Sender interface {
	SendReply(chatID int64, text string) error
}

// Agent executes one update turn.
type Agent struct {
	cfg *config.Config
	db  *sql.DB
	llm inference.Provider
	bot Sender
	log *slog.Logger
}

// New wires an Agent. llm is the inference.Provider interface so providers
// stay swappable without touching this package.
func New(cfg *config.Config, db *sql.DB, llm inference.Provider, bot Sender, log *slog.Logger) *Agent {
	return &Agent{cfg: cfg, db: db, llm: llm, bot: bot, log: log}
}

// HandleUpdate processes a single Telegram update. It is idempotent: a
// duplicate update_id is skipped before any side effect, so redeliveries
// and restarts never double-reply or double-persist.
func (a *Agent) HandleUpdate(ctx context.Context, updateID int64, fromUserID, chatID int64, text string) {
	log := a.log.With("update_id", updateID, "chat_id", chatID)

	// Locked personal bot: strangers are silently dropped before any
	// LLM call, state write, or reply. No signal back to the sender.
	if !a.cfg.IsAllowed(fromUserID) {
		log.Info("drop unauthorized sender")
		return
	}

	claimed, err := storage.ClaimUpdate(ctx, a.db, updateID)
	if err != nil {
		log.Error("claim update failed", "err", err)
		return
	}
	if !claimed {
		log.Info("skip duplicate update")
		return
	}

	text = truncate(strings.TrimSpace(text), maxInputChars)
	if text == "" {
		// Still mark processed: empty input needs no turn, and leaving
		// it unprocessed would retry forever.
		_ = storage.MarkUpdateProcessed(ctx, a.db, updateID)
		return
	}

	convID, err := storage.GetOrCreateConversation(ctx, a.db, chatID)
	if err != nil {
		log.Error("conversation failed", "err", err)
		return
	}
	if err := storage.AppendMessage(ctx, a.db, convID, "user", text); err != nil {
		log.Error("persist user message failed", "err", err)
		return
	}
	history, err := storage.RecentMessages(ctx, a.db, convID, historyLimit)
	if err != nil {
		log.Error("load history failed", "err", err)
		return
	}

	msgs := make([]inference.Message, 0, len(history))
	for _, m := range history {
		msgs = append(msgs, inference.Message{Role: m.Role, Text: m.Text})
	}
	reply, err := a.llm.Generate(ctx, msgs)
	if err != nil {
		// Fail recoverably: the user message is already durable, so a
		// later update can start a fresh turn. Tell the user plainly.
		log.Error("llm failed", "err", err)
		_ = a.bot.SendReply(chatID, "Maaf, aku lagi gagal mikir. Coba lagi sebentar ya.")
		return
	}
	reply = truncate(strings.TrimSpace(reply), maxReplyChars)
	if reply == "" {
		log.Error("empty model reply")
		return
	}
	if err := storage.AppendMessage(ctx, a.db, convID, "assistant", reply); err != nil {
		log.Error("persist assistant message failed", "err", err)
		return
	}
	if err := a.bot.SendReply(chatID, reply); err != nil {
		// Reply failed but state is durable; the turn stays
		// unprocessed so a redelivered update retries the send
		// without re-calling the model (dedupe via claim).
		log.Error("send reply failed", "err", err)
		return
	}
	if err := storage.MarkUpdateProcessed(ctx, a.db, updateID); err != nil {
		log.Error("mark processed failed", "err", err)
	}
}

func truncate(s string, max int) string {
	if utf8.RuneCountInString(s) <= max {
		return s
	}
	runes := []rune(s)
	return string(runes[:max])
}
