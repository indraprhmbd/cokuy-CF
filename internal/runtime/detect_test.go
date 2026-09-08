package runtime

import (
	"testing"

	"cokuy/internal/storage"
)

func TestParseDetectionValid(t *testing.T) {
	open := []storage.OpenLoop{{ID: 7, Title: "thesis"}}
	raw := `here you go {"loops":[{"title":"visa docs","context":"passport scan"}],"close_ids":[7],"reminders":[{"text":"call mom","due_in_minutes":60}]} done`
	det, err := parseDetection(raw, open)
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if len(det.Loops) != 1 || det.Loops[0].Title != "visa docs" {
		t.Fatalf("loops: %+v", det.Loops)
	}
	if len(det.CloseIDs) != 1 || det.CloseIDs[0] != 7 {
		t.Fatalf("close_ids: %+v", det.CloseIDs)
	}
	if len(det.Reminders) != 1 || det.Reminders[0].DueInMinutes != 60 {
		t.Fatalf("reminders: %+v", det.Reminders)
	}
}

func TestParseDetectionRejects(t *testing.T) {
	open := []storage.OpenLoop{{ID: 7, Title: "thesis"}}
	cases := map[string]string{
		"no json":          "just some text",
		"unknown close_id": `{"loops":[],"close_ids":[99],"reminders":[]}`,
		"empty title":      `{"loops":[{"title":" ","context":"x"}],"close_ids":[],"reminders":[]}`,
		"bad due":          `{"loops":[],"close_ids":[],"reminders":[{"text":"x","due_in_minutes":0}]}`,
		"due too far":      `{"loops":[],"close_ids":[],"reminders":[{"text":"x","due_in_minutes":999999}]}`,
	}
	for name, raw := range cases {
		if _, err := parseDetection(raw, open); err == nil {
			t.Fatalf("%s: expected error", name)
		}
	}
}
