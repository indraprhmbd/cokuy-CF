// Telegram boundary: webhook auth + sends. Sends go through the grammY Bot
// API client (BOT_INFO var skips the getMe cold call); the turn pipeline
// acks the webhook immediately and does heavy work in waitUntil, so grammY's
// webhookCallback is deliberately NOT used — it awaits handlers and would
// hold the 200 through the LLM call.

import { Bot } from "grammy";
import type { Env } from "./env";

/** Fail-closed: no configured secret means reject. */
export function webhookAuthorized(req: Request, secret: string | undefined): boolean {
  if (!secret) return false;
  return req.headers.get("x-telegram-bot-api-secret-token") === secret;
}

export interface Sender {
  sendReply(chatId: number, text: string): Promise<void>;
  sendTyping(chatId: number): Promise<void>;
}

/**
 * Parses the comma-separated allowlist. Empty = nobody allowed
 * (fail-closed). Throws on malformed entries.
 */
export function parseAllowlist(raw: string | undefined): Set<number> {
  const out = new Set<number>();
  for (const part of (raw ?? "").split(",")) {
    const trimmed = part.trim();
    if (trimmed === "") continue;
    const id = Number(trimmed);
    if (!Number.isInteger(id) || id <= 0) {
      throw new Error(`ALLOWED_USER_IDS must be comma-separated numeric IDs, got ${trimmed}`);
    }
    out.add(id);
  }
  return out;
}

/**
 * Builds a sender, or null when BOT_TOKEN is missing (fail-closed: turns
 * refuse to run rather than burn LLM calls they can never deliver).
 */
export function createSender(env: Env): Sender | null {
  if (!env.BOT_TOKEN) return null;
  // JSON.parse is any, which satisfies botInfo; invalid JSON falls back to
  // a getMe call on first send (fails loudly with a bad token, never silent).
  let options: ConstructorParameters<typeof Bot>[1];
  try {
    options = env.BOT_INFO ? { botInfo: JSON.parse(env.BOT_INFO) } : undefined;
  } catch {
    options = undefined;
  }
  const bot = new Bot(env.BOT_TOKEN, options);
  return {
    async sendReply(chatId: number, text: string): Promise<void> {
      await bot.api.sendMessage(chatId, text);
    },
    async sendTyping(chatId: number): Promise<void> {
      await bot.api.sendChatAction(chatId, "typing");
    },
  };
}
