// Package inference is Cokuy's provider-agnostic LLM boundary.
//
// Design: a narrow Generate interface with a single OpenAI-compatible
// implementation. Sumopod (https://ai.sumopod.com/v1), OpenRouter
// (https://openrouter.ai/api/v1), Ollama, vLLM, and any other
// OpenAI-compatible endpoint all speak POST /chat/completions with Bearer
// auth, so switching providers is an env change, never a code change.
//
// Deliberately Chat Completions, not the Responses API: the latter is
// OpenAI-only, while Chat Completions is the portable wire format.
//
// Model output is data, never trusted instructions: callers persist it as
// reply text via validated storage writes only.
package inference

import (
	"context"
	"fmt"
	"strings"
	"time"

	"github.com/openai/openai-go"
	"github.com/openai/openai-go/option"
)

// Message is one turn of conversation context for the model.
type Message struct {
	Role string // "system", "user", or "assistant"
	Text string
}

// Provider generates reply text from conversation context.
type Provider interface {
	Generate(ctx context.Context, msgs []Message) (string, error)
}

// OpenAICompatible is any OpenAI-compatible chat-completions endpoint
// (Sumopod, OpenRouter, Ollama, ...). ExtraHeaders carries optional
// provider extras such as OpenRouter's HTTP-Referer / X-Title ranking
// headers; it is empty for providers that need none.
type OpenAICompatible struct {
	client  openai.Client
	model   string
	timeout time.Duration
	// LastUsage holds token counts from the most recent Generate call,
	// for per-turn cost visibility. Not safe for concurrent use.
	LastUsage Usage
}

// Usage is prompt/completion token counts from one Generate call.
type Usage struct {
	Prompt     int64
	Completion int64
	Total      int64
}

// NewOpenAICompatible builds a provider from explicit values (env-supplied
// by the caller, typically from config).
func NewOpenAICompatible(baseURL, apiKey, model string, extraHeaders map[string]string, timeoutSecs int) *OpenAICompatible {
	opts := []option.RequestOption{
		option.WithBaseURL(strings.TrimRight(baseURL, "/")),
		option.WithAPIKey(apiKey),
		option.WithMaxRetries(2),
		option.WithRequestTimeout(20 * time.Second),
	}
	for k, v := range extraHeaders {
		k, v := k, v
		opts = append(opts, option.WithHeader(k, v))
	}
	timeout := 60 * time.Second
	if timeoutSecs > 0 {
		timeout = time.Duration(timeoutSecs) * time.Second
	}
	return &OpenAICompatible{
		client:  openai.NewClient(opts...),
		model:   model,
		timeout: timeout,
	}
}

// Generate calls the model with a system prompt pinning Cokuy's persona
// (mediocre friend-circle guy: kind, calm, humble about uncertainty),
// today's date (WIB), plus the conversation history. The overall deadline
// covers all retries.
func (p *OpenAICompatible) Generate(ctx context.Context, msgs []Message) (string, error) {
	ctx, cancel := context.WithTimeout(ctx, p.timeout)
	defer cancel()

	today := time.Now().In(time.FixedZone("WIB", 7*3600)).Format("Monday, 2006-01-02")
	params := openai.ChatCompletionNewParams{
		Model: p.model,
		Messages: []openai.ChatCompletionMessageParamUnion{
			openai.SystemMessage("You are Cokuy, the mediocre guy in the friend circle: casual, calm, kind, helpful without being overbearing. Never pretend certainty you do not have; say so when unsure. Keep replies short and practical. Today is " + today + " (WIB)."),
		},
	}
	for _, m := range msgs {
		text := strings.TrimSpace(m.Text)
		if text == "" {
			continue
		}
		switch m.Role {
		case "user":
			params.Messages = append(params.Messages, openai.UserMessage(text))
		case "assistant":
			params.Messages = append(params.Messages, openai.AssistantMessage(text))
		default:
			return "", fmt.Errorf("invalid message role %q", m.Role)
		}
	}

	resp, err := p.complete(ctx, params)
	if err != nil {
		return "", err
	}
	if len(resp.Choices) == 0 {
		return "", fmt.Errorf("llm generate: no choices in response")
	}
	p.LastUsage = Usage{
		Prompt:     resp.Usage.PromptTokens,
		Completion: resp.Usage.CompletionTokens,
		Total:      resp.Usage.TotalTokens,
	}
	text := strings.TrimSpace(resp.Choices[0].Message.Content)
	if text == "" {
		return "", fmt.Errorf("llm generate: empty reply")
	}
	return text, nil
}

// GenerateStructured calls the model with a caller-supplied system prompt
// and returns the raw reply text. It exists for machine-consumed outputs
// (JSON extraction) where the chat persona prompt would pollute the
// result. Callers validate the output; this method trusts nothing.
func (p *OpenAICompatible) GenerateStructured(ctx context.Context, sysPrompt, userPrompt string) (string, error) {
	ctx, cancel := context.WithTimeout(ctx, p.timeout)
	defer cancel()

	params := openai.ChatCompletionNewParams{
		Model: p.model,
		Messages: []openai.ChatCompletionMessageParamUnion{
			openai.SystemMessage(sysPrompt),
			openai.UserMessage(userPrompt),
		},
	}
	resp, err := p.complete(ctx, params)
	if err != nil {
		return "", err
	}
	if len(resp.Choices) == 0 {
		return "", fmt.Errorf("llm structured: no choices in response")
	}
	text := strings.TrimSpace(resp.Choices[0].Message.Content)
	if text == "" {
		return "", fmt.Errorf("llm structured: empty reply")
	}
	return text, nil
}

func (p *OpenAICompatible) complete(ctx context.Context, params openai.ChatCompletionNewParams) (*openai.ChatCompletion, error) {
	resp, err := p.client.Chat.Completions.New(ctx, params)
	if err != nil {
		return nil, fmt.Errorf("llm generate: %w", err)
	}
	return resp, nil
}
