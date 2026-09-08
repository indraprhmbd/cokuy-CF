// Scheduler is Cokuy's proactive path: a periodic tick that finds due
// work with pure SQL (zero LLM cost when idle), drafts nudge text for due
// loops, and drains the outbox through claim-before-send delivery.
//
// Gates, in order per row: claim -> quiet-hours check -> daily cap check
// -> send -> mark sent + kind side effects. Anything deferred releases its
// claim so a later tick retries; nothing proactive ever sends 22:00-07:00
// WIB, and no chat gets more than maxProactivePerDay sends per WIB day.
package runtime

import (
	"context"
	"database/sql"
	"fmt"
	"log/slog"
	"strings"
	"time"

	"cokuy/internal/storage"
)

const (
	// tickInterval is how often main.go runs Tick.
	tickInterval = 15 * time.Minute
	// loopStaleAfter makes a loop nudge-eligible this long after opening
	// (or last nudge). Personal-scale: one day.
	loopStaleAfter = 24 * time.Hour
	// maxLoopNudges bounds nudges per loop before it goes quiet for good.
	maxLoopNudges = 3
	// maxProactivePerDay caps delivered proactive sends per chat per WIB day.
	maxProactivePerDay = 3
	// quietStartHour / quietEndHour bound the no-unprompted-send window
	// (WIB). A send at exactly quietEndHour is allowed.
	quietStartHour = 22
	quietEndHour   = 7
	// tickBatchSize bounds rows touched per tick on a tiny VPS.
	tickBatchSize = 20
)

// StructuredLLM drafts machine-shaped text (nudges).
// *inference.OpenAICompatible satisfies it; test stubs can too without a
// network client.
type StructuredLLM interface {
	GenerateStructured(ctx context.Context, sysPrompt, userPrompt string) (string, error)
}

// Tick executes one scheduler pass at now. Safe to run when nothing is
// due: every stage is a cheap SQL check before any LLM or network work.
func Tick(ctx context.Context, db *sql.DB, bot Sender, llm StructuredLLM, log *slog.Logger, now time.Time) {
	wib := now.In(wibZone)
	flushReminders(ctx, db, wib, log)
	enqueueNudges(ctx, db, llm, wib, log)
	drainOutbox(ctx, db, bot, wib, log)
}

// flushReminders moves due reminders into the outbox. Delivery ownership
// passes to the outbox row (dedupe_key = reminder id); the reminder itself
// is marked sent only after successful delivery, so a crash between
// enqueue and send refires harmlessly (dedupe_key makes it one row).
func flushReminders(ctx context.Context, db *sql.DB, now time.Time, log *slog.Logger) {
	due, err := storage.DueReminders(ctx, db, now, tickBatchSize)
	if err != nil {
		log.Warn("tick: due reminders failed", "err", err)
		return
	}
	for _, r := range due {
		text := "Pengingat: " + r.Text
		if err := storage.EnqueueOutbox(ctx, db, r.ChatID, "reminder", &r.ID, text,
			fmt.Sprintf("reminder:%d", r.ID)); err != nil {
			log.Warn("tick: enqueue reminder failed", "id", r.ID, "err", err)
		}
	}
	if len(due) > 0 {
		log.Info("tick: reminders enqueued", "count", len(due))
	}
}

// enqueueNudges drafts one short nudge per due loop via the cheap model and
// queues it. LLM failure skips the loop (retried next tick); nothing is
// enqueued without drafted text.
func enqueueNudges(ctx context.Context, db *sql.DB, llm StructuredLLM, now time.Time, log *slog.Logger) {
	cutoff := now.Add(-loopStaleAfter).UTC().Format("2006-01-02T15:04:05.000Z")
	due, err := storage.DueLoops(ctx, db, cutoff, maxLoopNudges, tickBatchSize)
	if err != nil {
		log.Warn("tick: due loops failed", "err", err)
		return
	}
	for _, l := range due {
		text, err := llm.GenerateStructured(ctx,
			"You write one short follow-up nudge in casual Indonesian, like a friend checking in. "+
				"One or two sentences, no greeting fluff, no JSON, just the message text.",
			"Unfinished thread: "+l.Title+"\nDetail: "+l.Context)
		if err != nil {
			log.Warn("tick: nudge draft failed", "loop_id", l.ID, "err", err)
			continue
		}
		text = strings.TrimSpace(text)
		if text == "" {
			log.Warn("tick: empty nudge draft", "loop_id", l.ID)
			continue
		}
		day := now.Format("2006-01-02")
		if err := storage.EnqueueOutbox(ctx, db, l.ChatID, "nudge", &l.ID, text,
			fmt.Sprintf("nudge:%d:%s", l.ID, day)); err != nil {
			log.Warn("tick: enqueue nudge failed", "loop_id", l.ID, "err", err)
		}
	}
	if len(due) > 0 {
		log.Info("tick: nudges enqueued", "count", len(due))
	}
}

// drainOutbox delivers pending rows oldest-first. Each row: claim, then
// quiet-hours gate, then daily cap gate, then send. Deferred rows release
// their claim for a later tick; sent rows apply kind side effects
// (reminder marked sent, loop nudge counter bumped).
func drainOutbox(ctx context.Context, db *sql.DB, bot Sender, now time.Time, log *slog.Logger) {
	pending, err := storage.PendingOutbox(ctx, db, tickBatchSize)
	if err != nil {
		log.Warn("tick: pending outbox failed", "err", err)
		return
	}
	dayStart := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, wibZone).UTC().
		Format("2006-01-02T15:04:05.000Z")
	for _, m := range pending {
		claimed, err := storage.ClaimOutbox(ctx, db, m.ID)
		if err != nil || !claimed {
			continue
		}
		release := func(reason string) {
			log.Info("tick: send deferred", "outbox_id", m.ID, "reason", reason)
			if err := storage.ReleaseOutboxClaim(ctx, db, m.ID); err != nil {
				log.Warn("tick: release claim failed", "outbox_id", m.ID, "err", err)
			}
		}
		if inQuietHours(now) {
			release("quiet hours")
			continue
		}
		sent, err := storage.CountOutboxSentSince(ctx, db, m.ChatID, dayStart)
		if err != nil {
			log.Warn("tick: cap check failed", "outbox_id", m.ID, "err", err)
			_ = storage.ReleaseOutboxClaim(ctx, db, m.ID)
			continue
		}
		if sent >= maxProactivePerDay {
			release("daily cap")
			continue
		}
		if err := bot.SendReply(m.ChatID, m.Text); err != nil {
			log.Warn("tick: send failed", "outbox_id", m.ID, "err", err)
			_ = storage.ReleaseOutboxClaim(ctx, db, m.ID)
			continue
		}
		applySendSideEffects(ctx, db, m, log)
		if err := storage.MarkOutboxSent(ctx, db, m.ID); err != nil {
			log.Warn("tick: mark sent failed", "outbox_id", m.ID, "err", err)
		}
	}
}

// applySendSideEffects closes the loop/reminder behind a delivered send.
func applySendSideEffects(ctx context.Context, db *sql.DB, m storage.OutboxMessage, log *slog.Logger) {
	if m.RefID == nil {
		return
	}
	var err error
	switch m.Kind {
	case "reminder":
		err = storage.MarkReminderSent(ctx, db, *m.RefID)
	case "nudge":
		err = storage.TouchLoopNudged(ctx, db, *m.RefID)
	}
	if err != nil {
		log.Warn("tick: side effect failed", "outbox_id", m.ID, "err", err)
	}
}

// inQuietHours reports whether unprompted sends are gated at now (WIB).
func inQuietHours(now time.Time) bool {
	h := now.Hour()
	return h >= quietStartHour || h < quietEndHour
}
