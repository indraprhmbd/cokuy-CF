export interface Env {
  DB: D1Database;
  /** Must match the secret_token passed to Telegram setWebhook. Fail-closed: absent means 401. */
  TELEGRAM_WEBHOOK_SECRET?: string;
  /** Bot API token (wrangler secret). Missing token disables turns, loudly. */
  BOT_TOKEN?: string;
  /**
   * Public getMe JSON (wrangler var, NOT a secret). Lets grammY skip the
   * getMe cold call. Grab once: curl .../bot<TOKEN>/getMe -> {"ok":true,"result":{...}},
   * store the result object as compact JSON.
   */
  BOT_INFO?: string;
  /** Comma-separated numeric Telegram user IDs. Empty = nobody allowed (fail-closed). */
  ALLOWED_USER_IDS?: string;
  /** e.g. https://ai.sumopod.com/v1 or https://openrouter.ai/api/v1 */
  LLM_BASE_URL?: string;
  /** LLM API key (wrangler secret). */
  LLM_API_KEY?: string;
  LLM_MODEL?: string;
  /** Embedding model for semantic recall (wrangler var, e.g. text-embedding-3-small). */
  LLM_EMBED_MODEL?: string;
  /** Recall vector width (Matryoshka prefix); default 256. */
  LLM_EMBED_DIMS?: string;
  /** Optional JSON object of extra headers (e.g. OpenRouter HTTP-Referer/X-Title). */
  LLM_EXTRA_HEADERS?: string;
  /** Optional positive integer seconds; default 60. */
  LLM_TIMEOUT_S?: string;
  /** Optional USD per 1M prompt tokens for /usage math; default 0.03. */
  PRICE_IN_PER_M?: string;
  /** Optional USD per 1M completion tokens for /usage math; default 0.12. */
  PRICE_OUT_PER_M?: string;
}
