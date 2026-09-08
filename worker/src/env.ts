export interface Env {
  DB: D1Database;
  /** Must match the secret_token passed to Telegram setWebhook. Fail-closed: absent means 401. */
  TELEGRAM_WEBHOOK_SECRET?: string;
}
