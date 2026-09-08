import { Hono } from "hono";
import type { Env } from "./env";
import { webhookAuthorized } from "./telegram";

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
  if (!webhookAuthorized(c.req.raw, c.env.TELEGRAM_WEBHOOK_SECRET)) {
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
  // Phase 1: acknowledge only. The turn pipeline ports in a later phase.
  return c.json({ ok: true, update_id: updateId });
});

export default app;
