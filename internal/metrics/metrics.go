// Package metrics exposes a localhost-only JSON endpoint for the SvelteKit
// monitoring dashboard. stdlib net/http only: one route, bearer-token
// auth, read-only aggregates over the existing SQLite state.
//
// Security posture: bind loopback only (127.0.0.1), never 0.0.0.0. The
// server does not start when the token is empty (see cmd/cokuy), so
// metrics are off by default. The token is compared in constant time.
package metrics

import (
	"crypto/subtle"
	"database/sql"
	"encoding/json"
	"net/http"
	"strconv"

	"cokuy/internal/storage"
)

// Server serves dashboard metrics from the agent database.
type Server struct {
	db      *sql.DB
	token   string
	pricing Pricing
}

// Pricing is the USD-per-1M-tokens rate the spend figures are computed
// with, echoed so the dashboard can label which rate dollars assume.
type Pricing struct {
	PriceInPerM  float64 `json:"price_in_per_m"`
	PriceOutPerM float64 `json:"price_out_per_m"`
	Currency     string  `json:"currency"`
}

// New wires a metrics server. Token must be non-empty; callers refuse to
// start the HTTP listener otherwise.
func New(db *sql.DB, token string, priceInPerM, priceOutPerM float64) *Server {
	return &Server{db: db, token: token, pricing: Pricing{
		PriceInPerM: priceInPerM, PriceOutPerM: priceOutPerM, Currency: "USD",
	}}
}

// Handler returns the metrics mux. Only GET /metrics exists.
func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/metrics", s.handleMetrics)
	return mux
}

// Payload is the full dashboard snapshot.
type Payload struct {
	Totals        storage.Totals             `json:"totals"`
	Daily         []storage.DayUsage         `json:"daily"`
	RecentErrors  []storage.TurnError        `json:"recent_errors"`
	Conversations []storage.ConversationInfo `json:"conversations"`
	Pricing       Pricing                    `json:"pricing"`
}

// cost converts token counts to USD at the server's pricing.
func (s *Server) cost(promptTokens, completionTokens int64) float64 {
	return (float64(promptTokens)*s.pricing.PriceInPerM +
		float64(completionTokens)*s.pricing.PriceOutPerM) / 1_000_000
}

func (s *Server) handleMetrics(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if !s.authorized(r) {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	days := 30
	if raw := r.URL.Query().Get("days"); raw != "" {
		n, err := strconv.Atoi(raw)
		if err != nil || n < 1 || n > 365 {
			http.Error(w, "days must be 1..365", http.StatusBadRequest)
			return
		}
		days = n
	}

	ctx := r.Context()
	totals, err := storage.LifetimeTotals(ctx, s.db)
	if err != nil {
		http.Error(w, "totals failed", http.StatusInternalServerError)
		return
	}
	daily, err := storage.DailyUsage(ctx, s.db, days)
	if err != nil {
		http.Error(w, "daily failed", http.StatusInternalServerError)
		return
	}
	recentErrors, err := storage.RecentErrors(ctx, s.db, 50)
	if err != nil {
		http.Error(w, "errors failed", http.StatusInternalServerError)
		return
	}
	conversations, err := storage.ListConversations(ctx, s.db)
	if err != nil {
		http.Error(w, "conversations failed", http.StatusInternalServerError)
		return
	}
	if daily == nil {
		daily = []storage.DayUsage{}
	}
	if recentErrors == nil {
		recentErrors = []storage.TurnError{}
	}
	if conversations == nil {
		conversations = []storage.ConversationInfo{}
	}

	totals.CostUSD = s.cost(totals.PromptTokens, totals.CompletionTokens)
	for i := range daily {
		daily[i].CostUSD = s.cost(daily[i].PromptTokens, daily[i].CompletionTokens)
	}

	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(Payload{
		Totals:        totals,
		Daily:         daily,
		RecentErrors:  recentErrors,
		Conversations: conversations,
		Pricing:       s.pricing,
	})
}

func (s *Server) authorized(r *http.Request) bool {
	const prefix = "Bearer "
	h := r.Header.Get("Authorization")
	if len(h) <= len(prefix) || h[:len(prefix)] != prefix {
		return false
	}
	got := h[len(prefix):]
	if len(got) != len(s.token) {
		return false
	}
	return subtle.ConstantTimeCompare([]byte(got), []byte(s.token)) == 1
}
