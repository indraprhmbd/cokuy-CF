package metrics

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"

	"cokuy/internal/storage"
)

func testServer(t *testing.T) *Server {
	t.Helper()
	db, err := storage.Open(filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	t.Cleanup(func() { db.Close() })
	ctx := context.Background()
	if _, err := storage.ClaimUpdate(ctx, db, 1); err != nil {
		t.Fatalf("claim: %v", err)
	}
	if err := storage.RecordTurnStat(ctx, db, storage.TurnStat{
		UpdateID: 1, PromptTokens: 10, CompletionTokens: 5, TotalTokens: 15,
		Model: "m", LatencyMs: 100,
	}); err != nil {
		t.Fatalf("record: %v", err)
	}
	return New(db, "secret")
}

func TestMetricsRequiresAuth(t *testing.T) {
	s := testServer(t)
	for _, tc := range []struct {
		name   string
		header string
		want   int
	}{
		{"missing", "", http.StatusUnauthorized},
		{"wrong", "Bearer nope", http.StatusUnauthorized},
		{"ok", "Bearer secret", http.StatusOK},
	} {
		t.Run(tc.name, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodGet, "/metrics", nil)
			if tc.header != "" {
				req.Header.Set("Authorization", tc.header)
			}
			rec := httptest.NewRecorder()
			s.Handler().ServeHTTP(rec, req)
			if rec.Code != tc.want {
				t.Fatalf("code = %d, want %d", rec.Code, tc.want)
			}
		})
	}
}

func TestMetricsPayload(t *testing.T) {
	s := testServer(t)
	req := httptest.NewRequest(http.MethodGet, "/metrics?days=7", nil)
	req.Header.Set("Authorization", "Bearer secret")
	rec := httptest.NewRecorder()
	s.Handler().ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("code = %d, want 200", rec.Code)
	}
	var p Payload
	if err := json.NewDecoder(rec.Body).Decode(&p); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if p.Totals.Turns != 1 || p.Totals.TotalTokens != 15 {
		t.Fatalf("unexpected totals: %+v", p.Totals)
	}
	if len(p.Daily) != 1 || p.Daily[0].Turns != 1 {
		t.Fatalf("unexpected daily: %+v", p.Daily)
	}
}

func TestMetricsBadDays(t *testing.T) {
	s := testServer(t)
	req := httptest.NewRequest(http.MethodGet, "/metrics?days=abc", nil)
	req.Header.Set("Authorization", "Bearer secret")
	rec := httptest.NewRecorder()
	s.Handler().ServeHTTP(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("code = %d, want 400", rec.Code)
	}
}
