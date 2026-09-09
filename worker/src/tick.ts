// Port of internal/runtime/scheduler.go: the proactive path. Cron fires
// Tick; every stage is a cheap SQL check before any LLM or network work, so
// idle ticks cost ~zero. Gates per row: claim -> quiet-hours -> daily cap
// -> send -> mark sent + side effects. Deferred rows release their claim
// for a later tick. Nothing proactive ever sends 22:00-07:00 WIB; no chat
// gets more than MAX_PROACTIVE_PER_DAY sends per WIB day.

import type { Env } from "./env";
import { OpenAICompatible } from "./llm";
import { createSender, type Sender } from "./telegram";
import {
  claimOutbox,
  countOutboxSentSince,
  dueLoops,
  dueReminders,
  enqueueOutbox,
  markOutboxSent,
  markReminderSent,
  pendingOutbox,
  recordTurnStat,
  releaseOutboxClaim,
  touchLoopNudged,
  type OutboxMessage,
} from "./db";

const LOOP_STALE_AFTER_MS = 24 * 3600 * 1000;
const MAX_LOOP_NUDGES = 3;
const MAX_PROACTIVE_PER_DAY = 3;
const QUIET_START_HOUR = 22;
/** A send at exactly this hour is allowed. */
const QUIET_END_HOUR = 7;
const TICK_BATCH_SIZE = 20;
const WIB_OFFSET_MS = 7 * 3600 * 1000;

type Log = (level: "info" | "warn" | "error", msg: string, extra?: object) => void;

const log: Log = (level, msg, extra) => console[level](JSON.stringify({ cron: "tick", msg, ...extra }));

function wibParts(now: Date): { hour: number; date: string } {
  const wib = new Date(now.getTime() + WIB_OFFSET_MS);
  return { hour: wib.getUTCHours(), date: wib.toISOString().slice(0, 10) };
}

/** WIB-day-start expressed as a UTC timestamp string for sent_at comparisons. */
function wibDayStartUtc(now: Date): string {
  const { date } = wibParts(now);
  return new Date(`${date}T00:00:00+07:00`).toISOString();
}

function inQuietHours(wibHour: number): boolean {
  return wibHour >= QUIET_START_HOUR || wibHour < QUIET_END_HOUR;
}

function buildLlm(env: Env): OpenAICompatible | null {
  if (!env.LLM_BASE_URL || !env.LLM_API_KEY || !env.LLM_MODEL) return null;
  let extra: Record<string, string> = {};
  if (env.LLM_EXTRA_HEADERS?.trim()) {
    try {
      extra = JSON.parse(env.LLM_EXTRA_HEADERS) as Record<string, string>;
    } catch {
      return null;
    }
  }
  return new OpenAICompatible(env.LLM_BASE_URL, env.LLM_API_KEY, env.LLM_MODEL, extra, 60);
}

export async function tick(env: Env, now: Date): Promise<void> {
  const sender = createSender(env);
  const llm = buildLlm(env);
  if (!sender || !llm) {
    log("error", "missing BOT_TOKEN or LLM config; tick refused");
    return;
  }
  await flushReminders(env, now);
  await enqueueNudges(env, llm, now);
  await drainOutbox(env, sender, now);
}

// flushReminders moves due reminders into the outbox. Ownership passes to
// the outbox row (dedupe_key = reminder id); the reminder is marked sent
// only after delivery, so a crash between enqueue and send refires
// harmlessly (dedupe_key keeps it one row).
async function flushReminders(env: Env, now: Date): Promise<void> {
  let due;
  try {
    due = await dueReminders(env.DB, now, TICK_BATCH_SIZE);
  } catch (err) {
    log("warn", "tick: due reminders failed", { err: String(err) });
    return;
  }
  for (const r of due) {
    await enqueueOutbox(env.DB, r.chatId, "reminder", r.id, `Pengingat: ${r.text}`, `reminder:${r.id}`).catch(
      (err) => log("warn", "tick: enqueue reminder failed", { id: r.id, err: String(err) }),
    );
  }
  if (due.length > 0) log("info", "tick: reminders enqueued", { count: due.length });
}

async function enqueueNudges(env: Env, llm: OpenAICompatible, now: Date): Promise<void> {
  const cutoff = new Date(now.getTime() - LOOP_STALE_AFTER_MS).toISOString();
  let due;
  try {
    due = await dueLoops(env.DB, cutoff, MAX_LOOP_NUDGES, TICK_BATCH_SIZE);
  } catch (err) {
    log("warn", "tick: due loops failed", { err: String(err) });
    return;
  }
  const { date } = wibParts(now);
  for (const l of due) {
    let text: string;
    const draftStarted = Date.now();
    try {
      text = (
        await llm.generateStructured(
          "You write one short follow-up nudge in casual Indonesian, like a friend checking in. " +
            "One or two sentences, no greeting fluff, no JSON, just the message text.",
          `Unfinished thread: ${l.title}\nDetail: ${l.context}`,
        )
      ).text.trim();
      const u = llm.lastUsage;
      // Cron rows use update_id 0: no Telegram update exists there.
      await recordTurnStat(env.DB, {
        updateId: 0, kind: "nudge", promptTokens: u.prompt, completionTokens: u.completion,
        totalTokens: u.total, model: llm.modelName, latencyMs: Date.now() - draftStarted, error: "",
      }).catch((e) => log("warn", "tick: record nudge stat failed", { err: String(e) }));
    } catch (err) {
      log("warn", "tick: nudge draft failed", { loop_id: l.id, err: String(err) });
      continue;
    }
    if (!text) {
      log("warn", "tick: empty nudge draft", { loop_id: l.id });
      continue;
    }
    await enqueueOutbox(env.DB, l.chatId, "nudge", l.id, text, `nudge:${l.id}:${date}`).catch((err) =>
      log("warn", "tick: enqueue nudge failed", { loop_id: l.id, err: String(err) }),
    );
  }
  if (due.length > 0) log("info", "tick: nudges enqueued", { count: due.length });
}

async function drainOutbox(env: Env, sender: Sender, now: Date): Promise<void> {
  let pending;
  try {
    pending = await pendingOutbox(env.DB, TICK_BATCH_SIZE);
  } catch (err) {
    log("warn", "tick: pending outbox failed", { err: String(err) });
    return;
  }
  const { hour } = wibParts(now);
  const dayStart = wibDayStartUtc(now);
  for (const m of pending) {
    let claimed: boolean;
    try {
      claimed = await claimOutbox(env.DB, m.id);
    } catch {
      continue;
    }
    if (!claimed) continue;
    const release = async (reason: string) => {
      log("info", "tick: send deferred", { outbox_id: m.id, reason });
      await releaseOutboxClaim(env.DB, m.id).catch((err) =>
        log("warn", "tick: release claim failed", { outbox_id: m.id, err: String(err) }),
      );
    };
    if (inQuietHours(hour)) {
      await release("quiet hours");
      continue;
    }
    let sent: number;
    try {
      sent = await countOutboxSentSince(env.DB, m.chatId, dayStart);
    } catch (err) {
      log("warn", "tick: cap check failed", { outbox_id: m.id, err: String(err) });
      await releaseOutboxClaim(env.DB, m.id).catch(() => undefined);
      continue;
    }
    if (sent >= MAX_PROACTIVE_PER_DAY) {
      await release("daily cap");
      continue;
    }
    try {
      await sender.sendReply(m.chatId, m.text);
    } catch (err) {
      log("warn", "tick: send failed", { outbox_id: m.id, err: String(err) });
      await releaseOutboxClaim(env.DB, m.id).catch(() => undefined);
      continue;
    }
    await applySendSideEffects(env, m);
    await markOutboxSent(env.DB, m.id).catch((err) =>
      log("warn", "tick: mark sent failed", { outbox_id: m.id, err: String(err) }),
    );
  }
}

async function applySendSideEffects(env: Env, m: OutboxMessage): Promise<void> {
  if (m.refId == null) return;
  try {
    if (m.kind === "reminder") await markReminderSent(env.DB, m.refId);
    else if (m.kind === "nudge") await touchLoopNudged(env.DB, m.refId);
  } catch (err) {
    log("warn", "tick: side effect failed", { outbox_id: m.id, err: String(err) });
  }
}
