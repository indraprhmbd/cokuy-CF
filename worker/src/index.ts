import { Hono } from "hono";
import type { Env } from "./env";
import { claimUpdate, markUpdateProcessed } from "./db";
import { parseAllowlist, webhookAuthorized } from "./telegram";
import { handleUpdate } from "./turn";
import { tick } from "./tick";

const app = new Hono<{ Bindings: Env }>();

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
