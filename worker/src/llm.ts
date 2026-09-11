// Port of internal/inference (provider.go), minus the Go SDK: plain fetch
// against any OpenAI-compatible POST /chat/completions endpoint keeps the
// provider-agnostic boundary (Sumopod, OpenRouter, Ollama, vLLM = env
// change, never code change). Chat Completions, not Responses API: the
// latter is OpenAI-only, the former is the portable wire format.

export interface LlmMessage {
  role: "system" | "user" | "assistant" | "tool";
  text: string;
  /** Echoed as tool_calls for multi-step continuation. */
  toolCalls?: Array<{ id: string; name: string; args: string }>;
}

export interface LlmToolCall {
  id: string;
  name: string;
  args: string;
}

export interface LlmUsage {
  prompt: number;
  completion: number;
  total: number;
}

interface ChatCompletionsResponse {
  choices?: Array<{
    message?: {
      content?: string;
      tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: string } }>;
    };
    finish_reason?: string;
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
}

/** Opportunistic extras. Gateways/models may silently drop any of these;
 * callers must treat text as the primary channel and validate everything. */
export interface CompleteOptions {
  temperature?: number;
  maxTokens?: number;
  /** e.g. { type: "json_object" } or a json_schema shape. */
  responseFormat?: Record<string, unknown>;
  tools?: Array<Record<string, unknown>>;
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
  async generate(
    history: Array<{ role: string; text: string }>,
    profileBlock?: string,
    summaryBlock?: string,
    memoryBlock?: string,
    toolGuide?: string,
    tools?: Array<Record<string, unknown>>,
    maxToolSteps?: number,
    exec?: (name: string, args: string) => Promise<string>,
  ): Promise<string> {
    let system =
      "You are Cokuy, the mediocre guy in the friend circle: casual, calm, kind, " +
      "helpful without being overbearing. Never pretend certainty you do not have; " +
      "say so when unsure. Keep replies short and practical. " +
      "Voice (non-negotiable): Jakartan friend-circle casual, always gue/lu. " +
      "Never saya/Anda/kamu/bapak/ibu in any reply. Example: " +
      "'sipp, gue ingetin 2 menit lagi ya' - never 'saya ingetin'. " +
      "Reply ONLY in the user's language (Indonesian unless told otherwise). " +
      "Never use Chinese characters or classical Chinese. " +
      "Emojis are fine sparingly, but only common ones; never decorative " +
      "unicode symbols or broken characters. " +
      "Your real abilities, never deny them: you CAN set reminders from plain " +
      "requests like ingetin jam 12 (they get delivered even if the user is idle), " +
      "you DO track unfinished threads across turns, and proactive messages arrive " +
      "outside quiet hours (22:00-07:00 WIB). Ack requests committally. " +
       "Correction override: if your earlier messages claimed you cannot send " +
      "messages first or set reminders, that was an error. Do not repeat it; " +
      "demonstrate the ability instead. " +
      "Your slash commands (static list; answer ability questions from it, " +
      "never claim a listed command is missing): /today tugas hari ini, " +
      "/brief ringkasan sekarang, /usage token dan biaya, /remember <fakta> " +
      "simpan ingatan, /forget <kata kunci> hapus ingatan yang cocok, " +
      "/quiet lihat atau atur jam sepi, /help daftar perintah. " +
      `Today is ${wibToday(new Date())} (WIB).`;
    if (profileBlock?.trim()) system += ` ${profileBlock.trim()}`;
    if (summaryBlock?.trim()) system += ` ${summaryBlock.trim()}`;
    if (memoryBlock?.trim()) system += ` ${memoryBlock.trim()}`;
    if (toolGuide?.trim()) system += ` ${toolGuide.trim()}`;
    const messages: LlmMessage[] = [{ role: "system", text: system }];
    for (const m of history) {
      const text = m.text.trim();
      if (!text) continue;
      if (m.role === "user") messages.push({ role: "user", text });
      else if (m.role === "assistant") messages.push({ role: "assistant", text });
      else throw new Error(`invalid message role ${m.role}`);
    }
    if (tools !== undefined && exec !== undefined) {
      const looped = await this.chatWithTools(messages, { tools }, maxToolSteps ?? 2, exec);
      if (!looped.text) throw new Error("llm generate: empty reply");
      return looped.text;
    }
    const { text, usage } = await this.complete(messages);
    this.lastUsage = usage;
    if (!text) throw new Error("llm generate: empty reply");
    return text;
  }

  /**
   * Mid-turn tool loop (0013 Sprint 2). Runs complete() up to maxSteps+1
   * times: each round executes returned tool calls via exec and appends
   * results as role=tool messages. Usage accumulates into lastUsage.
   * Throws when every round fails or the final text is empty.
   */
  async chatWithTools(
    messages: LlmMessage[],
    opts: CompleteOptions,
    maxSteps: number,
    exec: (name: string, args: string) => Promise<string>,
  ): Promise<{ text: string; steps: number }> {
    const convo = messages.slice();
    const total: LlmUsage = { prompt: 0, completion: 0, total: 0 };
    let steps = 0;
    for (;;) {
      const r = await this.complete(convo, opts);
      total.prompt += r.usage.prompt;
      total.completion += r.usage.completion;
      total.total += r.usage.total;
      this.lastUsage = { ...total };
      if (r.toolCalls.length === 0 || steps >= maxSteps) {
        if (!r.text) throw new Error("llm tools: empty final reply");
        return { text: r.text, steps };
      }
      steps++;
      convo.push({ role: "assistant", text: r.text, toolCalls: r.toolCalls });
      for (const tc of r.toolCalls) {
        let out: string;
        try {
          out = await exec(tc.name, tc.args);
        } catch (err) {
          out = `error: ${err instanceof Error ? err.message : String(err)}`;
        }
        convo.push({ role: "tool", text: out });
      }
    }
  }

  /** Machine-consumed call with caller-supplied system prompt. Trusts nothing; callers validate. */
  async generateStructured(
    sysPrompt: string,
    userPrompt: string,
    opts: CompleteOptions = {},
  ): Promise<{ text: string; toolArgs: string | null }> {
    const { text, toolArgs, usage } = await this.complete(
      [
        { role: "system", text: sysPrompt },
        { role: "user", text: userPrompt },
      ],
      opts,
    );
    if (!text && !toolArgs) throw new Error("llm structured: empty reply");
    this.lastUsage = usage;
    return { text, toolArgs };
  }

  private async complete(
    messages: LlmMessage[],
    opts: CompleteOptions = {},
  ): Promise<{ text: string; usage: LlmUsage; toolArgs: string | null; toolCalls: LlmToolCall[] }> {
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
          // Extras are opportunistic: MiniMax/Sumopod may silently drop them.
          body: JSON.stringify({
            model: this.model,
            messages: messages.map((m) => ({
              role: m.role,
              content: m.text,
              ...(m.toolCalls !== undefined
                ? {
                    tool_calls: m.toolCalls.map((t) => ({
                      id: t.id,
                      type: "function",
                      function: { name: t.name, arguments: t.args },
                    })),
                  }
                : {}),
            })),
            ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
            ...(opts.maxTokens !== undefined ? { max_tokens: opts.maxTokens } : {}),
            ...(opts.responseFormat !== undefined ? { response_format: opts.responseFormat } : {}),
            ...(opts.tools !== undefined ? { tools: opts.tools, tool_choice: "auto" } : {}),
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
        const calls: LlmToolCall[] = [];
        for (const tc of body.choices[0].message?.tool_calls ?? []) {
          if (tc.function?.name) {
            calls.push({
              id: tc.id ?? `call_${calls.length}`,
              name: tc.function.name,
              args: tc.function.arguments ?? "{}",
            });
          }
        }
        return {
          text: (body.choices[0].message?.content ?? "").trim(),
          toolArgs: calls.length > 0 ? calls[0].args : null,
          toolCalls: calls,
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
