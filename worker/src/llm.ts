// Port of internal/inference (provider.go), minus the Go SDK: plain fetch
// against any OpenAI-compatible POST /chat/completions endpoint keeps the
// provider-agnostic boundary (Sumopod, OpenRouter, Ollama, vLLM = env
// change, never code change). Chat Completions, not Responses API: the
// latter is OpenAI-only, the former is the portable wire format.

export interface LlmMessage {
  role: "system" | "user" | "assistant";
  text: string;
}

export interface LlmUsage {
  prompt: number;
  completion: number;
  total: number;
}

interface ChatCompletionsResponse {
  choices?: Array<{ message?: { content?: string } }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
}

const WIB_OFFSET_MS = 7 * 3600 * 1000;

function wibToday(date: Date): string {
  const wib = new Date(date.getTime() + WIB_OFFSET_MS);
  const days = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  return `${days[wib.getUTCDay()]}, ${wib.toISOString().slice(0, 10)}`;
}

export class OpenAICompatible {
  lastUsage: LlmUsage = { prompt: 0, completion: 0, total: 0 };

  constructor(
    private baseURL: string,
    private apiKey: string,
    private model: string,
    private extraHeaders: Record<string, string> = {},
    private timeoutSecs = 60,
  ) {}

  get modelName(): string {
    return this.model;
  }

  /** Chat turn with the Cokuy persona prompt + history. Captures usage. */
  async generate(history: Array<{ role: string; text: string }>, profileBlock?: string): Promise<string> {
    let system =
      "You are Cokuy, the mediocre guy in the friend circle: casual, calm, kind, " +
      "helpful without being overbearing. Never pretend certainty you do not have; " +
      "say so when unsure. Keep replies short and practical. " +
      "Reply ONLY in the user's language (Indonesian unless told otherwise). " +
      "Never use Chinese characters or classical Chinese. " +
      "Emojis are fine sparingly, but only common ones; never decorative " +
      "unicode symbols or broken characters. " +
      `Today is ${wibToday(new Date())} (WIB).`;
    if (profileBlock?.trim()) system += ` ${profileBlock.trim()}`;
    const messages: LlmMessage[] = [{ role: "system", text: system }];
    for (const m of history) {
      const text = m.text.trim();
      if (!text) continue;
      if (m.role === "user") messages.push({ role: "user", text });
      else if (m.role === "assistant") messages.push({ role: "assistant", text });
      else throw new Error(`invalid message role ${m.role}`);
    }
    const { text, usage } = await this.complete(messages);
    this.lastUsage = usage;
    if (!text) throw new Error("llm generate: empty reply");
    return text;
  }

  /** Machine-consumed call with caller-supplied system prompt. Trusts nothing; callers validate. */
  async generateStructured(sysPrompt: string, userPrompt: string): Promise<string> {
    const { text } = await this.complete([
      { role: "system", text: sysPrompt },
      { role: "user", text: userPrompt },
    ]);
    if (!text) throw new Error("llm structured: empty reply");
    return text;
  }

  private async complete(messages: LlmMessage[]): Promise<{ text: string; usage: LlmUsage }> {
    const url = `${this.baseURL.replace(/\/+$/, "")}/chat/completions`;
    const started = Date.now();
    const deadline = started + Math.max(1, this.timeoutSecs) * 1000;
    let lastErr: unknown = new Error("llm generate: no attempts made");
    // Initial attempt + 2 retries, 20s per attempt, overall deadline on top.
    for (let attempt = 0; attempt < 3; attempt++) {
      if (Date.now() >= deadline) break;
      try {
        const res = await fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${this.apiKey}`,
            ...this.extraHeaders,
          },
          // Wire format needs `content`; LlmMessage carries `text` internally.
          body: JSON.stringify({
            model: this.model,
            messages: messages.map((m) => ({ role: m.role, content: m.text })),
          }),
          signal: AbortSignal.timeout(20000),
        });
        if (res.status === 429 || res.status >= 500) {
          lastErr = new Error(`llm generate: HTTP ${res.status}`);
          continue;
        }
        if (!res.ok) throw new Error(`llm generate: HTTP ${res.status}`);
        const body = (await res.json()) as ChatCompletionsResponse;
        if (!body.choices || body.choices.length === 0) {
          throw new Error("llm generate: no choices in response");
        }
        return {
          text: (body.choices[0].message?.content ?? "").trim(),
          usage: {
            prompt: body.usage?.prompt_tokens ?? 0,
            completion: body.usage?.completion_tokens ?? 0,
            total: body.usage?.total_tokens ?? 0,
          },
        };
      } catch (err) {
        lastErr = err;
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error(`llm generate: ${String(lastErr)}`);
  }
}
