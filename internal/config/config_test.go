package config

import (
	"testing"
)

func TestLoadRejectsEmptyAllowlist(t *testing.T) {
	t.Setenv("TELEGRAM_BOT_TOKEN", "test-token")
	t.Setenv("ALLOWED_USER_IDS", "")
	t.Setenv("LLM_BASE_URL", "https://ai.sumopod.com/v1")
	t.Setenv("LLM_API_KEY", "sk-test")
	t.Setenv("LLM_MODEL", "x")
	if _, err := Load(); err == nil {
		t.Fatal("expected error for empty ALLOWED_USER_IDS (must fail closed, never allow-all)")
	}
}

func TestLoadRejectsBadAllowlist(t *testing.T) {
	t.Setenv("TELEGRAM_BOT_TOKEN", "test-token")
	t.Setenv("ALLOWED_USER_IDS", "alice,123")
	t.Setenv("LLM_BASE_URL", "https://ai.sumopod.com/v1")
	t.Setenv("LLM_API_KEY", "sk-test")
	t.Setenv("LLM_MODEL", "x")
	if _, err := Load(); err == nil {
		t.Fatal("expected error for non-numeric ALLOWED_USER_IDS")
	}
}

func TestLoadOK(t *testing.T) {
	t.Setenv("TELEGRAM_BOT_TOKEN", "test-token")
	t.Setenv("ALLOWED_USER_IDS", "111, 222")
	t.Setenv("LLM_BASE_URL", "https://ai.sumopod.com/v1")
	t.Setenv("LLM_API_KEY", "sk-test")
	t.Setenv("LLM_MODEL", "some-model")
	c, err := Load()
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if !c.IsAllowed(111) || !c.IsAllowed(222) || c.IsAllowed(333) {
		t.Fatal("allowlist membership wrong")
	}
}
