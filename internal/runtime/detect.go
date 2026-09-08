// Loop and reminder detection runs once per successful turn, after the
// reply is sent and the update marked processed: it never delays the user.
// A second cheap-model call extracts unfinished threads ("loops") and
// explicit reminder requests as strict JSON; everything is validated
// before persistence, and parse failures only log. Model output is data,
// never trusted instructions.
package runtime

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"strings"
	"time"
	"unicode/utf8"

	"cokuy/internal/inference"
	"cokuy/internal/storage"
)

const (
	// maxDetectItems bounds each list the model may return per turn.
	maxDetectItems = 5
	// maxLoopTitleChars / maxLoopContextChars bound persisted detector text.
	maxLoopTitleChars   = 200
	maxLoopContextChars = 1000
	// maxReminderMinutes caps reminders at 30 days out.
	maxReminderMinutes = 43200
)

// wibZone pins due-time math to the user's timezone.
var wibZone = time.FixedZone("WIB", 7*3600)

// detection is the validated extraction result of one turn.
type detection struct {
	Loops     []loopCandidate     `json:"loops"`
	CloseIDs  []int64             `json:"close_ids"`
	Reminders []reminderCandidate `json:"reminders"`
}

type loopCandidate struct {
	Title   string `json:"title"`
	Context string `json:"context"`
}

type reminderCandidate struct {
	Text         string `json:"text"`
	DueInMinutes int64  `json:"due_in_minutes"`
}

// detectAndApply extracts loops/reminders from the just-finished exchange
// and persists them. llm providers without structured generation (e.g.
// test fakes) are silently skipped.
func (a *Agent) detectAndApply(ctx context.Context, chatID int64, userText, assistantReply string, log *slog.Logger) {
	sp, ok := a.llm.(*inference.OpenAICompatible)
	if !ok {
		return
	}
	open, err := storage.OpenLoops(ctx, a.db, chatID)
	if err != nil {
		log.Warn("detect: load open loops failed", "err", err)
		return
	}
	raw, err := sp.GenerateStructured(ctx, detectSystemPrompt(open), "USER:\n"+userText+"\nASSISTANT:\n"+assistantReply)
	if err != nil {
		log.Warn("detect: extraction call failed", "err", err)
		return
	}
	det, err := parseDetection(raw, open)
	if err != nil {
		log.Warn("detect: invalid extraction output", "err", err)
		return
	}
	now := time.Now().In(wibZone)
	for _, id := range det.CloseIDs {
		if err := storage.CloseLoop(ctx, a.db, id, chatID); err != nil {
			log.Warn("detect: close loop failed", "id", id, "err", err)
		}
	}
	for _, l := range det.Loops {
		if _, err := storage.OpenLoopOrExisting(ctx, a.db, chatID, l.Title, l.Context); err != nil {
			log.Warn("detect: open loop failed", "err", err)
		}
	}
	for _, r := range det.Reminders {
		due := now.Add(time.Duration(r.DueInMinutes) * time.Minute)
		if _, err := storage.CreateReminder(ctx, a.db, chatID, r.Text, due); err != nil {
			log.Warn("detect: create reminder failed", "err", err)
		}
	}
	log.Info("detect: applied",
		"loops", len(det.Loops), "closed", len(det.CloseIDs), "reminders", len(det.Reminders))
}

// detectSystemPrompt instructs JSON-only extraction. Open loops are listed
// so the model can reference close_ids and avoid re-emitting them.
func detectSystemPrompt(open []storage.OpenLoop) string {
	var b strings.Builder
	b.WriteString("You track unfinished threads and reminder requests from a chat turn. " +
		"Reply with JSON ONLY, no other text, in exactly this shape:\n" +
		"{\"loops\":[{\"title\":\"short thread name\",\"context\":\"one-line detail\"}]," +
		"\"close_ids\":[1],\"reminders\":[{\"text\":\"what to remind\",\"due_in_minutes\":120}]}\n" +
		"Rules: loops = concrete unfinished items (promises, plans, questions awaiting action), " +
		"never chit-chat or already-answered items. close_ids = IDs below clearly resolved this turn. " +
		"reminders = ONLY explicit requests to be reminded (\"remind me\", \"ingatkan\", \"kasih tau nanti\"). " +
		"due_in_minutes is relative to now. Empty lists when nothing qualifies.")
	if len(open) > 0 {
		b.WriteString("\nOpen loops:")
		for _, l := range open {
			fmt.Fprintf(&b, "\n- id=%d title=%q", l.ID, l.Title)
		}
	} else {
		b.WriteString("\nNo open loops.")
	}
	return b.String()
}

// parseDetection extracts the JSON object from raw model output and
// validates every field. Anything malformed is rejected wholesale: a
// half-parsed extraction must never reach storage.
func parseDetection(raw string, open []storage.OpenLoop) (detection, error) {
	start := strings.Index(raw, "{")
	end := strings.LastIndex(raw, "}")
	if start < 0 || end <= start {
		return detection{}, fmt.Errorf("no JSON object found")
	}
	var det detection
	if err := json.Unmarshal([]byte(raw[start:end+1]), &det); err != nil {
		return detection{}, fmt.Errorf("unmarshal: %w", err)
	}
	if len(det.Loops) > maxDetectItems || len(det.Reminders) > maxDetectItems ||
		len(det.CloseIDs) > maxDetectItems {
		return detection{}, fmt.Errorf("list exceeds cap of %d", maxDetectItems)
	}
	for i, l := range det.Loops {
		l.Title = strings.TrimSpace(l.Title)
		l.Context = strings.TrimSpace(l.Context)
		if l.Title == "" {
			return detection{}, fmt.Errorf("loop %d: empty title", i)
		}
		if utf8.RuneCountInString(l.Title) > maxLoopTitleChars {
			return detection{}, fmt.Errorf("loop %d: title too long", i)
		}
		if utf8.RuneCountInString(l.Context) > maxLoopContextChars {
			return detection{}, fmt.Errorf("loop %d: context too long", i)
		}
		det.Loops[i] = l
	}
	known := make(map[int64]bool, len(open))
	for _, l := range open {
		known[l.ID] = true
	}
	for _, id := range det.CloseIDs {
		if !known[id] {
			return detection{}, fmt.Errorf("close_id %d not open", id)
		}
	}
	for i, r := range det.Reminders {
		r.Text = strings.TrimSpace(r.Text)
		if r.Text == "" {
			return detection{}, fmt.Errorf("reminder %d: empty text", i)
		}
		if r.DueInMinutes < 1 || r.DueInMinutes > maxReminderMinutes {
			return detection{}, fmt.Errorf("reminder %d: due_in_minutes out of range", i)
		}
		det.Reminders[i] = r
	}
	return det, nil
}
