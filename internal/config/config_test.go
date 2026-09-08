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
	if c.LLMPriceInPerM != 0.03 || c.LLMPriceOutPerM != 0.12 {
		t.Fatalf("default pricing wrong: %v / %v", c.LLMPriceInPerM, c.LLMPriceOutPerM)
	}
}

func TestLoadPricingOverride(t *testing.T) {
	t.Setenv("TELEGRAM_BOT_TOKEN", "test-token")
	t.Setenv("ALLOWED_USER_IDS", "111")
	t.Setenv("LLM_BASE_URL", "https://ai.sumopod.com/v1")
	t.Setenv("LLM_API_KEY", "sk-test")
	t.Setenv("LLM_MODEL", "some-model")
	t.Setenv("LLM_PRICE_IN_PER_M", "1.5")
	t.Setenv("LLM_PRICE_OUT_PER_M", "2")
	c, err := Load()
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if c.LLMPriceInPerM != 1.5 || c.LLMPriceOutPerM != 2 {
		t.Fatalf("pricing override wrong: %v / %v", c.LLMPriceInPerM, c.LLMPriceOutPerM)
	}
}

func TestLoadRejectsBadPricing(t *testing.T) {
	t.Setenv("TELEGRAM_BOT_TOKEN", "test-token")
	t.Setenv("ALLOWED_USER_IDS", "111")
	t.Setenv("LLM_BASE_URL", "https://ai.sumopod.com/v1")
	t.Setenv("LLM_API_KEY", "sk-test")
	t.Setenv("LLM_MODEL", "some-model")
	t.Setenv("LLM_PRICE_IN_PER_M", "-1")
	if _, err := Load(); err == nil {
		t.Fatal("expected error for negative LLM_PRICE_IN_PER_M")
	}
}
