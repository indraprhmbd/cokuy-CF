// Package transport owns the Telegram boundary: long polling for inbound
// updates and sending replies. It knows nothing about the agent loop;
// it only moves Update objects in and message text out.
//
// Cost note: long polling is outbound-only (no domain, cert, or inbound
// port), so Telegram delivery itself is $0. Exactly one poller may run per
// bot token — a second one causes 409 Conflict for both.
package transport

import (
	"fmt"

	tgbotapi "github.com/go-telegram-bot-api/telegram-bot-api/v5"
)

// Bot wraps the Telegram Bot API client.
type Bot struct {
	api *tgbotapi.BotAPI
}

// New verifies the token via getMe and returns a client. debug must stay
// false in production: debug mode logs full requests including the token.
func New(token string) (*Bot, error) {
	api, err := tgbotapi.NewBotAPI(token)
	if err != nil {
		return nil, fmt.Errorf("telegram new client: %w", err)
	}
	api.Debug = false
	return &Bot{api: api}, nil
}

// Updates starts long polling: 45s server hold, up to 100 updates per
// batch, message updates only (cuts noise vs. receiving every update type).
// The channel closes on Stop; the library auto-advances the offset and
// reconnects after transient errors.
func (b *Bot) Updates() tgbotapi.UpdatesChannel {
	u := tgbotapi.NewUpdate(0)
	u.Timeout = 45
	u.Limit = 100
	u.AllowedUpdates = []string{"message"}
	return b.api.GetUpdatesChan(u)
}

// Stop terminates the polling goroutine and closes the updates channel.
func (b *Bot) Stop() {
	b.api.StopReceivingUpdates()
}

// SendTyping shows the "typing..." indicator in a chat. Telegram expires
// it after ~5 seconds, so callers must resend it during slow work.
func (b *Bot) SendTyping(chatID int64) error {
	action := tgbotapi.NewChatAction(chatID, tgbotapi.ChatTyping)
	if _, err := b.api.Send(action); err != nil {
		return fmt.Errorf("telegram typing: %w", err)
	}
	return nil
}
// SendReply sends text to a chat. Callers must pass validated, bounded
// text; Telegram caps messages at 4096 characters.
func (b *Bot) SendReply(chatID int64, text string) error {
	msg := tgbotapi.NewMessage(chatID, text)
	if _, err := b.api.Send(msg); err != nil {
		return fmt.Errorf("telegram send: %w", err)
	}
	return nil
}
