// Telegram boundary: webhook auth + sends. Sends go through the grammY Bot
// API client (BOT_INFO var skips the getMe cold call); the turn pipeline
// acks the webhook immediately and does heavy work in waitUntil, so grammY's
// webhookCallback is deliberately NOT used - it awaits handlers and would
// hold the 200 through the LLM call.

import { Bot } from "grammy";
import type { Env } from "./env";
import { markdownToHtml } from "./sanitize";

/** Fail-closed: no configured secret means reject. */
export function webhookAuthorized(req: Request, secret: string | undefined): boolean {
  if (!secret) return false;
  return req.headers.get("x-telegram-bot-api-secret-token") === secret;
}

export interface Sender {
  sendReply(chatId: number, text: string): Promise<void>;
  sendTyping(chatId: number): Promise<void>;
  sendWithKeyboard(chatId: number, text: string, keyboard: InlineKeyboard): Promise<number>;
  answerCallback(callbackId: string, text?: string): Promise<void>;
  editTaskMessage(chatId: number, messageId: number, text: string, keyboard: InlineKeyboard | null): Promise<void>;
}

export interface InlineButton {
  text: string;
  callback_data: string;
}

export interface InlineKeyboard {
  inline_keyboard: InlineButton[][];
}

/** Done / +1d / +3d triage row. Callback data stays under the 64-byte cap. */
export function taskKeyboard(taskId: number): InlineKeyboard {
  return {
    inline_keyboard: [
      [
        { text: "Beres", callback_data: `done:${taskId}` },
        { text: "+1d", callback_data: `snz1:${taskId}` },
        { text: "+3d", callback_data: `snz3:${taskId}` },
      ],
    ],
  };
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
  /**
   * Human-like fragmentation: long multi-paragraph replies send as up to 3
   * bubbles; short or single-paragraph replies always stay one. Split points
   * are the model's own blank lines. A tiny tail (<40 chars) merges into the
   * previous bubble so a lone "wkwk" never travels alone. Overflow paragraphs
   * merge into the last bubble. Pure function: unit-testable, no I/O.
   */
  function splitReply(text: string): string[] {
    const paras = text
      .split(/\n\s*\n/)
      .map((p) => p.trim())
      .filter((p) => p.length > 0);
    if (paras.length < 2 || [...text].length < 120) return [text];
    const parts = paras.slice(0, 3);
    if (paras.length > 3) parts[2] = [...parts.slice(2), ...paras.slice(3)].join("\n\n");
    const tail = parts[parts.length - 1];
    if (parts.length > 1 && [...tail].length < 40) {
      parts[parts.length - 2] = parts[parts.length - 2] + "\n" + tail;
      parts.pop();
    }
    return parts;
  }
  async function sendText(
    chatId: number,
    text: string,
    extra?: { reply_markup: InlineKeyboard },
  ): Promise<{ message_id: number }> {
    const html = markdownToHtml(text);
    if (html === null) {
      return bot.api.sendMessage(chatId, text, extra);
    }
    try {
      return await bot.api.sendMessage(chatId, html, { parse_mode: "HTML", ...extra });
    } catch {
      return bot.api.sendMessage(chatId, text, extra);
    }
  }
  return {
    /**
     * Conversational replies fragment into up to 3 bubbles. Each bubble
     * sends independently: a failed middle bubble logs and continues, so a
     * formatting edge degrades to a shorter reply, never a lost one. Throws
     * only when every bubble failed (preserves the old total-failure
     * contract for callers).
     */
    async sendReply(chatId: number, text: string): Promise<void> {
      const parts = splitReply(text);
      let failures = 0;
      for (const [i, part] of parts.entries()) {
        try {
          await sendText(chatId, part);
        } catch (err) {
          failures++;
          console.warn(
            JSON.stringify({
              msg: "sendReply: bubble failed, continuing",
              chat_id: chatId,
              bubble: `${i + 1}/${parts.length}`,
              err: String(err),
            }),
          );
        }
      }
      if (failures === parts.length) {
        throw new Error(`sendReply: all ${parts.length} bubbles failed`);
      }
    },
    async sendTyping(chatId: number): Promise<void> {
      await bot.api.sendChatAction(chatId, "typing");
    },
    async sendWithKeyboard(chatId: number, text: string, keyboard: InlineKeyboard): Promise<number> {
      const msg = await sendText(chatId, text, { reply_markup: keyboard });
      return msg.message_id;
    },
    async answerCallback(callbackId: string, text?: string): Promise<void> {
      await bot.api.answerCallbackQuery(callbackId, text ? { text } : undefined);
    },
    async editTaskMessage(
      chatId: number,
      messageId: number,
      text: string,
      keyboard: InlineKeyboard | null,
    ): Promise<void> {
      const html = markdownToHtml(text);
      const base = keyboard ? { reply_markup: keyboard } : {};
      if (html === null) {
        await bot.api.editMessageText(chatId, messageId, text, base);
        return;
      }
      try {
        await bot.api.editMessageText(chatId, messageId, html, { parse_mode: "HTML", ...base });
      } catch {
        await bot.api.editMessageText(chatId, messageId, text, base);
      }
    },
  };
}
