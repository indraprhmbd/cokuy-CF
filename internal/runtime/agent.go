// Package runtime is Cokuy's bounded agent turn:
//
//	receive update -> allowlist -> claim update_id -> load minimal state ->
//	call model -> validate writes -> persist -> reply -> mark processed.
//
// Explicit bounds: one LLM call per update, char-budgeted history window,
// 4000-char input cap, provider-level timeout. No tool execution in v0.1,
// so model output can only become reply text, never actions.
package runtime

import (
	"context"
	"database/sql"
	"log/slog"
	"strings"
	"time"
	"unicode/utf8"

	"cokuy/internal/config"
	"cokuy/internal/inference"
	"cokuy/internal/storage"
)

const (
	// historyFetchLimit caps rows read per turn; historyBudgetChars caps
	// what the model receives (newest-first), bounding cost per turn.
	historyFetchLimit  = 40
	historyBudgetChars = 10000
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

// Typer shows a typing indicator in a chat. The agent uses it only if
// the Sender also implements it, so test fakes stay minimal.
type Typer interface {
	SendTyping(chatID int64) error
}

// typingInterval resends the indicator before Telegram's ~5s expiry.
const typingInterval = 4 * time.Second

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
	history, err := storage.RecentMessages(ctx, a.db, convID, historyFetchLimit)
	if err != nil {
		log.Error("load history failed", "err", err)
		return
	}
	history = budgetHistory(history, historyBudgetChars)

	msgs := make([]inference.Message, 0, len(history))
	for _, m := range history {
		msgs = append(msgs, inference.Message{Role: m.Role, Text: m.Text})
	}
	start := time.Now()
	stopTyping := startTyping(a.bot, chatID, log)
	reply, err := a.llm.Generate(ctx, msgs)
	stopTyping()
	latencyMs := time.Since(start).Milliseconds()
	if err != nil {
		// Fail recoverably: the user message is already durable, so a
		// later update can start a fresh turn. Tell the user plainly.
		log.Error("llm failed", "err", err)
		_ = storage.RecordTurnStat(ctx, a.db, storage.TurnStat{
			UpdateID: updateID, Model: a.cfg.LLMModel, LatencyMs: latencyMs, Error: err.Error(),
		})
		_ = a.bot.SendReply(chatID, "Maaf, aku lagi gagal mikir. Coba lagi sebentar ya.")
		return
	}
	var usage inference.Usage
	if p, ok := a.llm.(*inference.OpenAICompatible); ok {
		usage = p.LastUsage
		log.Info("llm usage", "prompt_tokens", usage.Prompt, "completion_tokens", usage.Completion, "total_tokens", usage.Total)
	}
	reply = truncate(strings.TrimSpace(reply), maxReplyChars)
	if reply == "" {
		log.Error("empty model reply")
		_ = storage.RecordTurnStat(ctx, a.db, storage.TurnStat{
			UpdateID: updateID, Model: a.cfg.LLMModel, LatencyMs: latencyMs, Error: "empty model reply",
		})
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
	_ = storage.RecordTurnStat(ctx, a.db, storage.TurnStat{
		UpdateID:         updateID,
		PromptTokens:     usage.Prompt,
		CompletionTokens: usage.Completion,
		TotalTokens:      usage.Total,
		Model:            a.cfg.LLMModel,
		LatencyMs:        latencyMs,
	})
}

// budgetHistory keeps the newest messages fitting within maxChars (rune
// count), always retaining at least the latest message.
func budgetHistory(msgs []storage.Message, maxChars int) []storage.Message {
	keep := 0
	total := 0
	for i := len(msgs) - 1; i >= 0; i-- {
		total += utf8.RuneCountInString(msgs[i].Text)
		if total > maxChars {
			break
		}
		keep++
	}
	if keep == 0 && len(msgs) > 0 {
		keep = 1
	}
	return msgs[len(msgs)-keep:]
}

// startTyping sends one typing indicator immediately and keeps resending
// it until the returned stop func runs. Typing failures only log: the
// indicator is cosmetic and must never fail a turn. Senders without Typer
// (e.g. test fakes) are silently skipped.
func startTyping(bot Sender, chatID int64, log *slog.Logger) (stop func()) {
	typer, ok := bot.(Typer)
	if !ok {
		return func() {}
	}
	send := func() {
		if err := typer.SendTyping(chatID); err != nil {
			log.Warn("typing indicator failed", "err", err)
		}
	}
	send()
	ticker := time.NewTicker(typingInterval)
	done := make(chan struct{})
	go func() {
		for {
			select {
			case <-ticker.C:
				send()
			case <-done:
				ticker.Stop()
				return
			}
		}
	}()
	return func() { close(done) }
}

func truncate(s string, max int) string {
	if utf8.RuneCountInString(s) <= max {
		return s
	}
	runes := []rune(s)
	return string(runes[:max])
}
