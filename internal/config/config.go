// Package config loads Cokuy's runtime configuration from the environment.
//
// Every secret arrives via environment variables only. Nothing is read from
// source files, and validation fails closed: missing or malformed values
// return an error instead of a zero-value default that could silently widen
// access (e.g. an empty allowlist must never mean "allow everyone").
package config

import (
	"encoding/json"
	"fmt"
	"os"
	"strconv"
	"strings"
)

// Config is the full v0.1 runtime configuration.
type Config struct {
	TelegramBotToken string
	AllowedUserIDs   map[int64]struct{}
	SQLitePath       string

	LLMBaseURL      string
	LLMAPIKey       string
	LLMModel        string
	LLMExtraHeaders map[string]string
	LLMTimeoutSecs  int

	// MetricsAddr is the loopback listen address for the dashboard
	// metrics endpoint. MetricsToken enables it; empty disables.
	MetricsAddr  string
	MetricsToken string
}

// Load reads and validates configuration from the environment.
func Load() (*Config, error) {
	c := &Config{
		TelegramBotToken: strings.TrimSpace(os.Getenv("TELEGRAM_BOT_TOKEN")),
		SQLitePath:       strings.TrimSpace(os.Getenv("SQLITE_PATH")),
		LLMBaseURL:       strings.TrimSpace(os.Getenv("LLM_BASE_URL")),
		LLMAPIKey:        strings.TrimSpace(os.Getenv("LLM_API_KEY")),
		LLMModel:         strings.TrimSpace(os.Getenv("LLM_MODEL")),
	}
	if c.TelegramBotToken == "" {
		return nil, fmt.Errorf("TELEGRAM_BOT_TOKEN is required")
	}
	if c.SQLitePath == "" {
		c.SQLitePath = "cokuy.db"
	}

	allow, err := parseAllowlist(os.Getenv("ALLOWED_USER_IDS"))
	if err != nil {
		return nil, err
	}
	if len(allow) == 0 {
		return nil, fmt.Errorf("ALLOWED_USER_IDS must contain at least one numeric Telegram user ID (locked personal bot: never default to allow-all)")
	}
	c.AllowedUserIDs = allow

	if c.LLMBaseURL == "" {
		return nil, fmt.Errorf("LLM_BASE_URL is required (e.g. https://ai.sumopod.com/v1 or https://openrouter.ai/api/v1)")
	}
	if c.LLMAPIKey == "" {
		return nil, fmt.Errorf("LLM_API_KEY is required")
	}
	if c.LLMModel == "" {
		return nil, fmt.Errorf("LLM_MODEL is required")
	}

	headers := map[string]string{}
	if raw := strings.TrimSpace(os.Getenv("LLM_EXTRA_HEADERS")); raw != "" {
		if err := json.Unmarshal([]byte(raw), &headers); err != nil {
			return nil, fmt.Errorf("LLM_EXTRA_HEADERS must be a JSON object: %w", err)
		}
	}
	c.LLMExtraHeaders = headers

	c.LLMTimeoutSecs = 60
	if raw := strings.TrimSpace(os.Getenv("LLM_TIMEOUT_S")); raw != "" {
		n, err := strconv.Atoi(raw)
		if err != nil || n <= 0 {
			return nil, fmt.Errorf("LLM_TIMEOUT_S must be a positive integer of seconds")
		}
		c.LLMTimeoutSecs = n
	}

	c.MetricsAddr = strings.TrimSpace(os.Getenv("METRICS_ADDR"))
	if c.MetricsAddr == "" {
		c.MetricsAddr = "127.0.0.1:8090"
	}
	c.MetricsToken = strings.TrimSpace(os.Getenv("METRICS_TOKEN"))
	return c, nil
}

// IsAllowed reports whether a Telegram sender ID is on the allowlist.
func (c *Config) IsAllowed(userID int64) bool {
	_, ok := c.AllowedUserIDs[userID]
	return ok
}

func parseAllowlist(raw string) (map[int64]struct{}, error) {
	out := map[int64]struct{}{}
	for _, part := range strings.Split(raw, ",") {
		part = strings.TrimSpace(part)
		if part == "" {
			continue
		}
		id, err := strconv.ParseInt(part, 10, 64)
		if err != nil || id <= 0 {
			return nil, fmt.Errorf("ALLOWED_USER_IDS must be comma-separated numeric Telegram user IDs, got %q", part)
		}
		out[id] = struct{}{}
	}
	return out, nil
}
