import { Hono } from "hono";
import type { Env } from "./env";
import { claimUpdate, markUpdateProcessed } from "./db";
import { parseAllowlist, webhookAuthorized } from "./telegram";
import { handleUpdate } from "./turn";
import { handleCallback } from "./tasks_view";
import { handleCommand } from "./commands";
import { tick } from "./tick";

const app = new Hono<{ Bindings: Env }>();

interface ParsedCallback {
  fromId: number;
  chatId: number;
  callbackId: string;
  messageId: number;
  origText: string;
  data: string;
}

/** Extracts a triage button press. Null when not a callback update. */
function parseCallbackQuery(update: unknown): ParsedCallback | null {
  if (typeof update !== "object" || update === null || !("callback_query" in update)) return null;
  const cb = (update as { callback_query: unknown }).callback_query;
  if (typeof cb !== "object" || cb === null) return null;
  const c = cb as {
    id?: unknown;
    from?: { id?: unknown };
    message?: { message_id?: unknown; chat?: { id?: unknown }; text?: unknown };
    data?: unknown;
  };
  const fromId = c.from?.id;
  const chatId = c.message?.chat?.id;
  if (typeof c.id !== "string" || typeof fromId !== "number" || typeof chatId !== "number") return null;
  if (typeof c.message?.message_id !== "number" || typeof c.data !== "string") return null;
  return {
    fromId,
    chatId,
    callbackId: c.id,
    messageId: c.message.message_id,
    origText: typeof c.message.text === "string" ? c.message.text : "",
    data: c.data,
  };
}

/** Shared allowlist gate (fail-closed on bad config). Null = drop. */
async function allowlisted(env: Env, updateId: number, fromId: number): Promise<boolean> {
  let allowed: Set<number>;
  try {
    allowed = parseAllowlist(env.ALLOWED_USER_IDS);
  } catch (err) {
    console.error(JSON.stringify({ update_id: updateId, msg: "bad allowlist config", err: String(err) }));
    return false;
  }
  return allowed.has(fromId);
}

app.get("/health", async (c) => {
  try {
    const row = await c.env.DB.prepare("SELECT 1 AS ok").first<{ ok: number }>();
    return c.json({ ok: true, service: "cokuy-cf", db: row?.ok === 1 });
  } catch {
    return c.json({ ok: false, service: "cokuy-cf", error: "db_unavailable" }, 503);
  }
});

app.post("/telegram", async (c) => {
  const env = c.env;
  if (!webhookAuthorized(c.req.raw, env.TELEGRAM_WEBHOOK_SECRET)) {
    return c.json({ ok: false, error: "unauthorized" }, 401);
  }
  let update: unknown;
  try {
    update = await c.req.json();
  } catch {
    return c.json({ ok: false, error: "bad_json" }, 400);
  }
  const updateId =
    typeof update === "object" && update !== null && "update_id" in update
      ? (update as { update_id: unknown }).update_id
      : undefined;
  if (typeof updateId !== "number") {
    return c.json({ ok: false, error: "bad_update" }, 400);
  }

  // Message-only, like the Go poller's AllowedUpdates=["message"].
  const msg =
    typeof update === "object" && update !== null && "message" in update
      ? (update as { message: unknown }).message
      : undefined;
  const text =
    typeof msg === "object" && msg !== null && "text" in msg ? (msg as { text: unknown }).text : undefined;
  const fromId =
    typeof msg === "object" && msg !== null && "from" in msg
      ? (msg as { from: { id?: unknown } }).from?.id
      : undefined;
  const chatId =
    typeof msg === "object" && msg !== null && "chat" in msg
      ? (msg as { chat: { id?: unknown } }).chat?.id
      : undefined;
  if (typeof text !== "string" || typeof fromId !== "number" || typeof chatId !== "number") {
    // Callback triage presses (Done/Snooze) ride here; everything else
    // non-message is claimed + closed so it never lingers unprocessed.
    const cb = parseCallbackQuery(update);
    if (cb) {
      if (!(await allowlisted(env, updateId, cb.fromId))) {
        return c.json({ ok: true, update_id: updateId, dropped: true });
      }
      const { fromId: cf, chatId: cc, callbackId, messageId, origText, data } = cb;
      const clog = (level: "info" | "warn" | "error", msg: string, extra?: object) =>
        console[level](JSON.stringify({ update_id: updateId, chat_id: cc, msg, ...extra }));
      c.executionCtx.waitUntil(
        handleCallback(env, updateId, cc, callbackId, messageId, origText, data, clog).catch((err) =>
          console.error(JSON.stringify({ update_id: updateId, msg: "callback crashed", err: String(err) })),
        ),
      );
      return c.json({ ok: true, update_id: updateId });
    }
    // Non-message updates: claim + close so they never linger unprocessed.
    try {
      if (await claimUpdate(env.DB, updateId)) await markUpdateProcessed(env.DB, updateId);
    } catch (err) {
      console.error(JSON.stringify({ update_id: updateId, msg: "non-message claim failed", err: String(err) }));
      return c.json({ ok: false, error: "db_unavailable" }, 503);
    }
    return c.json({ ok: true, update_id: updateId, skipped: true });
  }

  // Locked personal bot: strangers silently dropped before any claim, LLM
  // call, or write — same order as the Go turn.
  let allowed: Set<number>;
  try {
    allowed = parseAllowlist(env.ALLOWED_USER_IDS);
  } catch (err) {
    console.error(JSON.stringify({ update_id: updateId, msg: "bad allowlist config", err: String(err) }));
    return c.json({ ok: true, update_id: updateId, dropped: true });
  }
  if (!allowed.has(fromId)) return c.json({ ok: true, update_id: updateId, dropped: true });

  // Slash commands render deterministically; they never enter the LLM
  // turn (except via tool results like get_usage).
  if (text.trimStart().startsWith("/")) {
    const tlog = (level: "info" | "warn" | "error", msg: string, extra?: object) =>
      console[level](JSON.stringify({ update_id: updateId, chat_id: chatId, msg, ...extra }));
    c.executionCtx.waitUntil(
      handleCommand(env, updateId, chatId, text, tlog).catch((err) =>
        console.error(JSON.stringify({ update_id: updateId, msg: "command crashed", err: String(err) })),
      ),
    );
    return c.json({ ok: true, update_id: updateId });
  }

  // Immediate 200; the bounded turn runs in waitUntil (claim inside is the
  // concurrency guard, not the old sequential poll loop).
  c.executionCtx.waitUntil(
    handleUpdate(env, updateId, fromId, chatId, text).catch((err) =>
      console.error(JSON.stringify({ update_id: updateId, msg: "turn crashed", err: String(err) })),
    ),
  );
  return c.json({ ok: true, update_id: updateId });
});

export default {
  fetch: app.fetch,
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(tick(env, new Date(event.scheduledTime)));
  },
};
