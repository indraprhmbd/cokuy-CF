package inference

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// stubCompat serves a minimal OpenAI-compatible /chat/completions endpoint.
func stubCompat(t *testing.T, reply string, check func(r *http.Request)) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !strings.HasSuffix(r.URL.Path, "/chat/completions") {
			http.NotFound(w, r)
			return
		}
		if check != nil {
			check(r)
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"choices": []map[string]any{
				{"message": map[string]any{"role": "assistant", "content": reply}},
			},
		})
	}))
}

func TestGenerateOK(t *testing.T) {
	srv := stubCompat(t, "  hai  ", func(r *http.Request) {
		if got := r.Header.Get("Authorization"); got != "Bearer sk-test" {
			t.Errorf("Authorization = %q", got)
		}
	})
	defer srv.Close()

	p := NewOpenAICompatible(srv.URL, "sk-test", "stub-model", nil, 10)
	out, err := p.Generate(context.Background(), []Message{{Role: "user", Text: "halo"}})
	if err != nil {
		t.Fatalf("Generate: %v", err)
	}
	if out != "hai" {
		t.Fatalf("Generate = %q, want trimmed reply", out)
	}
}

func TestGenerateExtraHeaders(t *testing.T) {
	srv := stubCompat(t, "ok", func(r *http.Request) {
		if got := r.Header.Get("HTTP-Referer"); got != "https://example.com" {
			t.Errorf("HTTP-Referer = %q (OpenRouter attribution must pass through)", got)
		}
	})
	defer srv.Close()

	p := NewOpenAICompatible(srv.URL, "k", "m", map[string]string{"HTTP-Referer": "https://example.com"}, 10)
	if _, err := p.Generate(context.Background(), []Message{{Role: "user", Text: "hi"}}); err != nil {
		t.Fatalf("Generate: %v", err)
	}
}

func TestGenerateRejectsBadRole(t *testing.T) {
	srv := stubCompat(t, "x", nil)
	defer srv.Close()

	p := NewOpenAICompatible(srv.URL, "k", "m", nil, 10)
	if _, err := p.Generate(context.Background(), []Message{{Role: "system", Text: "x"}}); err == nil {
		t.Fatal("expected error for invalid role")
	}
}

func TestGenerateEmptyReply(t *testing.T) {
	srv := stubCompat(t, "   ", nil)
	defer srv.Close()

	p := NewOpenAICompatible(srv.URL, "k", "m", nil, 10)
	if _, err := p.Generate(context.Background(), []Message{{Role: "user", Text: "hi"}}); err == nil {
		t.Fatal("expected error for empty model reply")
	}
}
