// Port of internal/runtime/agent.go: one bounded update turn.
// receive -> allowlist -> claim update_id -> minimal state -> model ->
// validate -> persist -> reply -> mark processed -> post-turn detection.
//
// Bounds: one LLM call per update, char-budgeted history, 4000-char caps,
// provider timeout. No tool execution: model output becomes reply text only.
// Idempotent: duplicate update_id skips before any side effect.

import type { Env } from "./env";
import { OpenAICompatible } from "./llm";
import { createSender, parseAllowlist } from "./telegram";
import {
  appendMessage,
  claimUpdate,
  closeLoop,
  createReminder,
  getOrCreateConversation,
  getProfileFacts,
  markUpdateProcessed,
  openLoopOrExisting,
  openLoops,
  recentMessages,
  recordTurnStat,
  upsertProfileFact,
} from "./db";
import { detectSystemPrompt as buildDetectPrompt, parseDetection, RECORD_STATE_TOOL } from "./detect";
import { sanitizeReply } from "./sanitize";

const HISTORY_FETCH_LIMIT = 40;
const HISTORY_BUDGET_CHARS = 10000;
const MAX_INPUT_CHARS = 4000;
/** Telegram caps messages at 4096 chars; keep margin. */
const MAX_REPLY_CHARS = 4000;
/** Resend cadence for the typing indicator (Telegram expires it in ~5s). */
const TYPING_INTERVAL_MS = 4000;

const WIB_OFFSET_MS = 7 * 3600 * 1000;

/** Router pre-gate for the detector: explicit reminder verbs, durable-fact
 * phrases, or task words force a run. Chit-chat without open loops skips it. */
const DETECT_TRIGGER_RE =
  /inget|ingatkan|remind|kasih tau|jangan lupa|namaku|nama (saya|gue|aku)|suka |sukanya|prefer|bahasanya|todo|tugas|janji|deadline|utang/i;

function truncate(s: string, max: number): string {
  const runes = [...s];
  return runes.length <= max ? s : runes.slice(0, max).join("");
}

/** Newest messages fitting maxChars (rune count), always keeping the latest. */
function budgetHistory<T extends { text: string }>(msgs: T[], maxChars: number): T[] {
  let keep = 0;
  let total = 0;
  for (let i = msgs.length - 1; i >= 0; i--) {
    total += [...msgs[i].text].length;
    if (total > maxChars) break;
    keep++;
  }
  if (keep === 0 && msgs.length > 0) keep = 1;
  return msgs.slice(msgs.length - keep);
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
  let timeout = 60;
  if (env.LLM_TIMEOUT_S?.trim()) {
    const n = Number(env.LLM_TIMEOUT_S.trim());
    if (!Number.isInteger(n) || n <= 0) return null;
    timeout = n;
  }
  return new OpenAICompatible(env.LLM_BASE_URL, env.LLM_API_KEY, env.LLM_MODEL, extra, timeout);
}

export async function handleUpdate(
  env: Env,
  updateId: number,
  fromUserId: number,
  chatId: number,
  text: string,
): Promise<void> {
  const log = (level: "info" | "warn" | "error", msg: string, extra?: object) =>
    console[level](JSON.stringify({ update_id: updateId, chat_id: chatId, msg, ...extra }));

  // Locked personal bot: strangers silently dropped before any LLM call, write, or reply.
  let allowed: Set<number>;
  try {
    allowed = parseAllowlist(env.ALLOWED_USER_IDS);
  } catch (err) {
    log("error", "bad allowlist config", { err: String(err) });
    return;
  }
  if (!allowed.has(fromUserId)) {
    log("info", "drop unauthorized sender");
    return;
  }

  // Deviation from Go (documented): Go can't boot without token/LLM env;
  // the Worker stays up for /health, so turns fail closed here instead —
  // before the claim, so a redelivery retries after the config is fixed.
  const sender = createSender(env);
  const llm = buildLlm(env);
  if (!sender || !llm) {
    log("error", "missing BOT_TOKEN or LLM config; turn refused");
    return;
  }

  let claimed: boolean;
  try {
    claimed = await claimUpdate(env.DB, updateId);
  } catch (err) {
    log("error", "claim update failed", { err: String(err) });
    return;
  }
  if (!claimed) {
    log("info", "skip duplicate update");
    return;
  }

  text = truncate(text.trim(), MAX_INPUT_CHARS);
  if (!text) {
    // Empty input needs no turn; mark processed so it never retries.
    await markUpdateProcessed(env.DB, updateId).catch((err) =>
      log("error", "mark processed failed", { err: String(err) }),
    );
    return;
  }

  let convId: number;
  try {
    convId = await getOrCreateConversation(env.DB, chatId);
  } catch (err) {
    log("error", "conversation failed", { err: String(err) });
    return;
  }
  try {
    await appendMessage(env.DB, convId, "user", text);
  } catch (err) {
    log("error", "persist user message failed", { err: String(err) });
    return;
  }
  let history: Array<{ role: string; text: string }>;
  try {
    history = budgetHistory(await recentMessages(env.DB, convId, HISTORY_FETCH_LIMIT), HISTORY_BUDGET_CHARS);
  } catch (err) {
    log("error", "load history failed", { err: String(err) });
    return;
  }
  // Profile facts are tiny and deterministic: loaded whole, injected whole.
  let profileBlock = "";
  try {
    const facts = await getProfileFacts(env.DB, chatId);
    if (facts.length > 0) {
      profileBlock =
        "You remember about this user: " +
        facts.map((f) => `${f.key}=${f.value}`).join("; ") +
        ". Honor the language fact: reply in their language.";
    }
  } catch (err) {
    log("warn", "load profile failed", { err: String(err) });
  }

  const started = Date.now();
  sender.sendTyping(chatId).catch((err) => log("warn", "typing indicator failed", { err: String(err) }));
  const typer = setInterval(() => {
    sender.sendTyping(chatId).catch((err) => log("warn", "typing indicator failed", { err: String(err) }));
  }, TYPING_INTERVAL_MS);
  let reply: string;
  try {
    reply = await llm.generate(history, profileBlock);
  } catch (err) {
    clearInterval(typer);
    const latencyMs = Date.now() - started;
    log("error", "llm failed", { err: String(err) });
    await recordTurnStat(env.DB, {
      updateId, promptTokens: 0, completionTokens: 0, totalTokens: 0,
      model: llm.modelName, latencyMs, error: String(err),
    }).catch((e) => log("error", "record stat failed", { err: String(e) }));
    await sender.sendReply(chatId, "Maaf, aku lagi gagal mikir. Coba lagi sebentar ya.").catch((e) =>
      log("error", "failure reply failed", { err: String(e) }),
    );
    return;
  }
  clearInterval(typer);
  const latencyMs = Date.now() - started;
  const usage = llm.lastUsage;
  log("info", "llm usage", {
    prompt_tokens: usage.prompt, completion_tokens: usage.completion, total_tokens: usage.total,
  });

  reply = truncate(reply.trim(), MAX_REPLY_CHARS);
  // Model sometimes emits mojibake / non-Latin leaks: scrub before persist
  // and send so stored history and Telegram never carry visible garbage.
  const clean = sanitizeReply(reply);
  if (clean.stripped > 0) log("warn", "reply sanitized", { stripped: clean.stripped });
  reply = clean.text.trim();
  if (!reply) {
    log("error", "empty model reply");
    await recordTurnStat(env.DB, {
      updateId, promptTokens: usage.prompt, completionTokens: usage.completion,
      totalTokens: usage.total, model: llm.modelName, latencyMs, error: "empty model reply",
    }).catch((e) => log("error", "record stat failed", { err: String(e) }));
    return;
  }
  try {
    await appendMessage(env.DB, convId, "assistant", reply);
  } catch (err) {
    log("error", "persist assistant message failed", { err: String(err) });
    return;
  }
  try {
    await sender.sendReply(chatId, reply);
  } catch (err) {
    // State durable, turn stays unprocessed; redelivery retries the send
    // without re-calling the model (dedupe via claim).
    log("error", "send reply failed", { err: String(err) });
    return;
  }
  await markUpdateProcessed(env.DB, updateId).catch((err) =>
    log("error", "mark processed failed", { err: String(err) }),
  );
  await recordTurnStat(env.DB, {
    updateId, promptTokens: usage.prompt, completionTokens: usage.completion,
    totalTokens: usage.total, model: llm.modelName, latencyMs, error: "",
  }).catch((err) => log("error", "record stat failed", { err: String(err) }));

  // Post-turn extraction: never delays the user; failures only log.
  await detectAndApply(env, llm, chatId, text, reply, log);
}

async function detectAndApply(
  env: Env,
  llm: OpenAICompatible,
  chatId: number,
  userText: string,
  assistantReply: string,
  log: (level: "info" | "warn" | "error", msg: string, extra?: object) => void,
): Promise<void> {
  let open;
  try {
    open = await openLoops(env.DB, chatId);
  } catch (err) {
    log("warn", "detect: load open loops failed", { err: String(err) });
    return;
  }
  // Router pre-gate: chit-chat with no open loops skips the detector call.
  // Heuristic, documented: trigger verbs/fact phrases force a run.
  if (open.length === 0 && !DETECT_TRIGGER_RE.test(`${userText}\n${assistantReply}`)) {
    log("info", "detect: skipped by router");
    return;
  }
  const sys = buildDetectPrompt(open);
  const user = `USER:\n${userText}\nASSISTANT:\n${assistantReply}`;
  let raw: string;
  let toolArgs: string | null;
  try {
    ({ text: raw, toolArgs } = await llm.generateStructured(sys, user, {
      responseFormat: { type: "json_object" },
      tools: [RECORD_STATE_TOOL as unknown as Record<string, unknown>],
    }));
  } catch (err) {
    log("warn", "detect: extraction call failed", { err: String(err) });
    return;
  }
  let parsed;
  try {
    parsed = parseDetection(raw, open, toolArgs);
  } catch (err) {
    // Budget-1 retry: re-prompt with the compact validator error.
    log("info", "detect: retrying after parse failure", { err: String(err) });
    try {
      ({ text: raw, toolArgs } = await llm.generateStructured(
        `${sys}\nYour last output failed validation: ${String(err).slice(0, 200)}. Reply with corrected JSON only.`,
        user,
        { temperature: 0.2, maxTokens: 500 },
      ));
      parsed = parseDetection(raw, open, toolArgs);
    } catch (err2) {
      log("warn", "detect: invalid extraction output", { err: String(err2) });
      return;
    }
  }
  const det = parsed.det;
  for (const id of det.closeIds) {
    await closeLoop(env.DB, id, chatId).catch((err) =>
      log("warn", "detect: close loop failed", { id, err: String(err) }),
    );
  }
  for (const l of det.loops) {
    await openLoopOrExisting(env.DB, chatId, l.title, l.context).catch((err) =>
      log("warn", "detect: open loop failed", { err: String(err) }),
    );
  }
  for (const r of det.reminders) {
    // Truncate due to the minute: redelivery recomputes the same key, so
    // INSERT OR IGNORE dedupes the retry (migration 005). Real UTC clock:
    // dueInMinutes is relative to now, never the WIB-shifted wall clock.
    const due = new Date(Date.now() + r.dueInMinutes * 60000);
    due.setSeconds(0, 0);
    await createReminder(env.DB, chatId, r.text, due).catch((err) =>
      log("warn", "detect: create reminder failed", { err: String(err) }),
    );
  }
  for (const p of det.profile) {
    await upsertProfileFact(env.DB, chatId, p.key, p.value).catch((err) =>
      log("warn", "detect: save profile fact failed", { key: p.key, err: String(err) }),
    );
  }
  log("info", "detect: applied", {
    loops: det.loops.length, closed: det.closeIds.length, reminders: det.reminders.length,
    profile: det.profile.length, dropped: parsed.dropped,
  });
}
