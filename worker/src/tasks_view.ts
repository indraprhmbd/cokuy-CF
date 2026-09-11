// 0015 Phase 1: task views + triage callbacks. One message per due task
// (each with its own Done/+1d/+3d keyboard), one summary for inbox +
// loops. Callbacks are idempotent via the update_id claim; every press is
// answered and edited in place so triage never spams the chat.

import type { Env } from "./env";
import { createSender, taskKeyboard } from "./telegram";
import {
  claimUpdate,
  completeTask,
  getTask,
  markUpdateProcessed,
  openLoops,
  snoozeTask,
  tasksDueThrough,
  tasksInbox,
  type TaskRow,
} from "./db";

const WIB_OFFSET_MS = 7 * 3600 * 1000;
const TODAY_TASK_LIMIT = 10;

type Log = (level: "info" | "warn" | "error", msg: string, extra?: object) => void;

/** End of the current WIB day as a UTC ISO string (Today boundary). */
export function todayEndUtc(now: Date): string {
  const wib = new Date(now.getTime() + WIB_OFFSET_MS);
  const day = wib.toISOString().slice(0, 10);
  return new Date(`${day}T23:59:59+07:00`).toISOString();
}

/** WIB day-month for a UTC instant ("10 Sep"). */
function wibDayMonth(iso: string): string {
  const months = ["Jan", "Feb", "Mar", "Apr", "Mei", "Jun", "Jul", "Agu", "Sep", "Okt", "Nov", "Des"];
  const wib = new Date(new Date(iso).getTime() + WIB_OFFSET_MS);
  return `${wib.getUTCDate()} ${months[wib.getUTCMonth()]}`;
}

function taskLine(t: TaskRow, now: Date): string {
  const due = t.dueAt ? ` (jatuh tempo ${wibDayMonth(t.dueAt)})` : "";
  const over = t.dueAt && t.dueAt < now.toISOString() ? " - telat!" : "";
  const dl = t.deadlineAt ? ` [deadline ${wibDayMonth(t.deadlineAt)}]` : "";
  return `- ${t.title}${due}${over}${dl}`;
}

/** /today: per-due-task actionable messages + one inbox/loops summary. */
export async function handleToday(
  env: Env,
  updateId: number,
  chatId: number,
  log: Log,
): Promise<void> {
  const sender = createSender(env);
  if (!sender) {
    log("error", "today: missing BOT_TOKEN");
    return;
  }
  let claimed = false;
  try {
    claimed = await claimUpdate(env.DB, updateId);
  } catch (err) {
    log("error", "today: claim failed", { err: String(err) });
    return;
  }
  if (!claimed) {
    log("info", "today: skip duplicate update");
    return;
  }
  const now = new Date();
  let due: TaskRow[] = [];
  let inbox: TaskRow[] = [];
  let loops: number = 0;
  try {
    due = await tasksDueThrough(env.DB, chatId, todayEndUtc(now), TODAY_TASK_LIMIT);
    inbox = await tasksInbox(env.DB, chatId, TODAY_TASK_LIMIT);
    loops = (await openLoops(env.DB, chatId)).length;
  } catch (err) {
    log("error", "today: load failed", { err: String(err) });
    return;
  }
  for (const t of due) {
    try {
      await sender.sendWithKeyboard(chatId, taskLine(t, now), taskKeyboard(t.id));
    } catch (err) {
      log("error", "today: send task failed", { id: t.id, err: String(err) });
    }
  }
  const bits: string[] = [];
  if (due.length === 0) bits.push("Nggak ada yang jatuh tempo hari ini. Santai.");
  else bits.push(`${due.length} tugas buat hari ini di atas, satu-satu ya.`);
  if (inbox.length > 0) {
    bits.push(`Inbox (${inbox.length}): ` + inbox.map((t) => t.title).join("; "));
  }
  if (loops > 0) bits.push(`${loops} utas kebuka nunggu kelanjutan.`);
  try {
    await sender.sendReply(chatId, bits.join("\n"));
  } catch (err) {
    log("error", "today: send summary failed", { err: String(err) });
    return;
  }
  await markUpdateProcessed(env.DB, updateId).catch((err) =>
    log("error", "today: mark processed failed", { err: String(err) }),
  );
}

/** Parses triage callback data. Null = unknown shape, answer + ignore. */
function parseCallback(data: string): { op: "done" | "snz"; days: number; taskId: number } | null {
  const m = data.match(/^(done|snz1|snz3):(\d{1,10})$/);
  if (!m) return null;
  const taskId = Number(m[2]);
  if (!Number.isInteger(taskId) || taskId <= 0) return null;
  if (m[1] === "done") return { op: "done", days: 0, taskId };
  return { op: "snz", days: m[1] === "snz1" ? 1 : 3, taskId };
}

/** Triage press: claim -> apply -> answer -> edit in place. */
export async function handleCallback(
  env: Env,
  updateId: number,
  chatId: number,
  callbackId: string,
  messageId: number,
  origText: string,
  data: string,
  log: Log,
): Promise<void> {
  const sender = createSender(env);
  if (!sender) {
    log("error", "callback: missing BOT_TOKEN");
    return;
  }
  let claimed = false;
  try {
    claimed = await claimUpdate(env.DB, updateId);
  } catch (err) {
    log("error", "callback: claim failed", { err: String(err) });
    return;
  }
  if (!claimed) {
    await sender.answerCallback(callbackId).catch(() => undefined);
    return;
  }
  const done = async () => {
    await markUpdateProcessed(env.DB, updateId).catch((err) =>
      log("error", "callback: mark processed failed", { err: String(err) }),
    );
  };
  const parsed = parseCallback(data);
  if (!parsed) {
    await sender.answerCallback(callbackId, "nggak ngerti tombolnya").catch(() => undefined);
    await done();
    return;
  }
  if (parsed.op === "done") {
    const moved = await completeTask(env.DB, parsed.taskId, chatId).catch(() => false);
    await sender
      .answerCallback(callbackId, moved ? "beres. mantap." : "udah beres / nggak ada.")
      .catch(() => undefined);
    if (moved) {
      await sender.editTaskMessage(chatId, messageId, `${origText}\n- beres.`, null).catch((err) =>
        log("warn", "callback: edit failed", { err: String(err) }),
      );
    }
    await done();
    return;
  }
  const moved = await snoozeTask(env.DB, parsed.taskId, chatId, parsed.days).catch(() => false);
  if (!moved) {
    await sender.answerCallback(callbackId, "nggak bisa diundur.").catch(() => undefined);
    await done();
    return;
  }
  const t = await getTask(env.DB, parsed.taskId, chatId).catch(() => null);
  const when = t?.dueAt ? wibDayMonth(t.dueAt) : `${parsed.days} hari lagi`;
  await sender
    .answerCallback(callbackId, `diundur ke ${when}.`)
    .catch(() => undefined);
  await sender
    .editTaskMessage(chatId, messageId, `${origText}\n- diundur ke ${when}.`, taskKeyboard(parsed.taskId))
    .catch((err) => log("warn", "callback: edit failed", { err: String(err) }));
  await done();
}
