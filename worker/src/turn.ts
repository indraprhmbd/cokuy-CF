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
  getConversationSummary,
  getOrCreateConversation,
  getProfileFacts,
  markUpdateProcessed,
  memoriesForChat,
  messagesChunk,
  openLoopOrExisting,
  openLoops,
  recentMessagesAfter,
  recordFactHistory,
  recordFeedback,
  recordTurnStat,
  saveMemory,
  touchMemories,
  unsummarizedSpan,
  upsertConversationSummary,
  upsertProfileFact,
} from "./db";
import { cosine, embedTexts } from "./embed";
import { executeMemoryTool, MEMORY_TOOL_GUIDE, MEMORY_TOOLS } from "./memory_tools";
import { detectSystemPrompt as buildDetectPrompt, parseDetection, RECORD_STATE_TOOL } from "./detect";
import { sanitizeReply } from "./sanitize";

const HISTORY_FETCH_LIMIT = 40;
const HISTORY_BUDGET_CHARS = 10000;
/** Rolling summary: compact once unsummarized rows pass this count. */
const SUMMARIZE_THRESHOLD = 60;
/** Messages left untouched above the new watermark after compaction. */
const SUMMARIZE_KEEP_RECENT = 30;
const SUMMARY_MAX_CHARS = 1500;
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

/** 0013 recall: semantic memory retrieval over stored memories. */
const RECALL_THRESHOLD = 0.72;
const RECALL_TOP_K = 5;
const RECALL_BUDGET_CHARS = 1500;
/** Below this length the turn is pure ack; embedding it wastes a call. */
const RECALL_SKIP_RUNES = 6;
const RECALL_MAX_ROWS = 2000;

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
  let priorSummary = "";
  try {
    const s = await getConversationSummary(env.DB, convId);
    priorSummary = s.summary.trim();
    history = budgetHistory(
      await recentMessagesAfter(env.DB, convId, s.throughMessageId, HISTORY_FETCH_LIMIT),
      HISTORY_BUDGET_CHARS,
    );
  } catch (err) {
    log("error", "load history failed", { err: String(err) });
    return;
  }
  // Profile facts are tiny and deterministic: loaded whole, injected whole,
  // newest first with an explicit latest-wins header (0012 precedence rule).
  let profileBlock = "";
  try {
    const facts = await getProfileFacts(env.DB, chatId);
    if (facts.length > 0) {
      profileBlock =
        "You remember about this user (newest first; latest fact wins on conflict): " +
        facts.map((f) => `${f.key}=${f.value}`).join("; ") +
        ". Honor the language fact: reply in their language.";
    }
  } catch (err) {
    log("warn", "load profile failed", { err: String(err) });
  }

  // Rolling summary is injected whole (tiny, ~1.5k chars max); the live
  // window above the watermark carries verbatim turns.
  const summaryBlock = priorSummary
    ? "Earlier conversation (summarized, oldest first): " + priorSummary
    : "";

  // 0013 recall: semantic memories for this query. Router-gated, never
  // blocking: embed failure means zero memories, never a failed turn.
  // Same gate arms mid-turn memory tools (no schema tax on chit-chat).
  let memoryBlock = "";
  let toolsOn = false;
  if ([...text].length > RECALL_SKIP_RUNES) {
    toolsOn = true;
    memoryBlock = await recallMemories(env, updateId, chatId, text, log);
  }

  const started = Date.now();
  sender.sendTyping(chatId).catch((err) => log("warn", "typing indicator failed", { err: String(err) }));
  const typer = setInterval(() => {
    sender.sendTyping(chatId).catch((err) => log("warn", "typing indicator failed", { err: String(err) }));
  }, TYPING_INTERVAL_MS);
  let reply: string;
  try {
    reply = toolsOn
      ? await llm.generate(history, profileBlock, summaryBlock, memoryBlock, MEMORY_TOOL_GUIDE, MEMORY_TOOLS, 2, (name, args) =>
          executeMemoryTool(env, chatId, updateId, name, args),
        )
      : await llm.generate(history, profileBlock, summaryBlock, memoryBlock);
  } catch (err) {
    clearInterval(typer);
    const latencyMs = Date.now() - started;
    log("error", "llm failed", { err: String(err) });
    await recordTurnStat(env.DB, {
      updateId, kind: "chat", promptTokens: 0, completionTokens: 0, totalTokens: 0,
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
      updateId, kind: "chat", promptTokens: usage.prompt, completionTokens: usage.completion,
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
    updateId, kind: "chat", promptTokens: usage.prompt, completionTokens: usage.completion,
    totalTokens: usage.total, model: llm.modelName, latencyMs, error: "",
  }).catch((err) => log("error", "record stat failed", { err: String(err) }));

  // Post-turn extraction: never delays the user; failures only log.
  await detectAndApply(env, llm, updateId, chatId, text, reply, log);
  // Rolling compaction, same waitUntil budget: cheap SQL-first check keeps
  // idle turns at ~zero cost; the LLM call fires only past threshold.
  await compactIfNeeded(env, llm, updateId, convId, priorSummary, log);
  // 0012 feedback signals: pure local heuristics, one tiny write.
  await recordFeedSignals(env, updateId, text, history, log);
}

/** Explicit correction opener (ID + EN). Anchored: only the turn start counts. */
const CORRECTION_RE =
  /^(no[,. ]|wrong|not that|bukan|salah|gak|nggak|ngga|jangan|maksud (gue|gw|saya|aku)|actually|eh )/i;
/** Token overlap at or above this marks the turn a rephrase of the prior ask. */
const REPHRASE_JACCARD = 0.6;

function contentTokens(s: string): Set<string> {
  return new Set(
    s
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 2),
  );
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const w of a) if (b.has(w)) inter++;
  return inter / (a.size + b.size - inter);
}

async function recordFeedSignals(
  env: Env,
  updateId: number,
  text: string,
  history: Array<{ role: string; text: string }>,
  log: (level: "info" | "warn" | "error", msg: string, extra?: object) => void,
): Promise<void> {
  const isCorrection = CORRECTION_RE.test(text.trim());
  // Prior user ask = last user message before the current turn's own text.
  // History is chronological and ends with the current user message.
  let prev: string | null = null;
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].role !== "user") continue;
    if (history[i].text.trim() === text.trim()) continue;
    prev = history[i].text;
    break;
  }
  const isRephrase =
    prev !== null && jaccard(contentTokens(text), contentTokens(prev)) >= REPHRASE_JACCARD;
  if (!isCorrection && !isRephrase) return;
  try {
    await recordFeedback(env.DB, updateId, isCorrection, isRephrase);
  } catch (err) {
    log("warn", "record feedback failed", { err: String(err) });
    return;
  }
  log("info", "feedback signal", { correction: isCorrection, rephrase: isRephrase });
}

/**
 * 0013 semantic recall. Embeds the query, cosine-scores same-chat
 * memories, injects top-k above threshold inside a char budget with
 * memory IDs for use-tracking. Any failure (config, embed, D1) returns
 * "" so the turn proceeds memoryless. Records a "recall" ledger row.
 */
async function recallMemories(
  env: Env,
  updateId: number,
  chatId: number,
  text: string,
  log: (level: "info" | "warn" | "error", msg: string, extra?: object) => void,
): Promise<string> {
  const baseURL = env.LLM_BASE_URL;
  const apiKey = env.LLM_API_KEY;
  const model = env.LLM_EMBED_MODEL;
  if (!baseURL || !apiKey || !model) return "";
  let extra: Record<string, string> = {};
  if (env.LLM_EXTRA_HEADERS?.trim()) {
    try {
      extra = JSON.parse(env.LLM_EXTRA_HEADERS) as Record<string, string>;
    } catch {
      return "";
    }
  }
  const started = Date.now();
  let query: number[];
  let dims = 0;
  let promptTokens = 0;
  try {
    const r = await embedTexts(baseURL, apiKey, model, [text], extra);
    query = r.vectors[0];
    dims = r.dims;
    promptTokens = r.usage.prompt;
  } catch (err) {
    log("warn", "recall: embed failed", { err: String(err) });
    return "";
  }
  log("info", "recall: embedded", { dims, latency_ms: Date.now() - started });
  let rows;
  try {
    rows = await memoriesForChat(env.DB, chatId, RECALL_MAX_ROWS);
  } catch (err) {
    log("warn", "recall: load memories failed", { err: String(err) });
    return "";
  }
  const scored = rows
    .map((m) => ({ m, s: cosine(query, m.embedding) }))
    .filter((x) => x.s >= RECALL_THRESHOLD)
    .sort((a, b) => b.s - a.s)
    .slice(0, RECALL_TOP_K);
  const recallMs = Date.now() - started;
  const recordRecall = (error: string) =>
    recordTurnStat(env.DB, {
      updateId, kind: "recall", promptTokens, completionTokens: 0,
      totalTokens: promptTokens, model, latencyMs: recallMs, error,
    }).catch((err) => log("warn", "recall: stat failed", { err: String(err) }));
  if (scored.length === 0) {
    log("info", "recall: no hit", { scanned: rows.length });
    await recordRecall("");
    return "";
  }
  // Budget newest-first? No: score order carries relevance; clamp lines.
  let total = 0;
  const kept: typeof scored = [];
  for (const x of scored) {
    const len = [...x.m.text].length;
    if (total + len > RECALL_BUDGET_CHARS && kept.length > 0) break;
    total += len;
    kept.push(x);
  }
  const ids = kept.map((x) => x.m.id);
  await touchMemories(env.DB, ids).catch((err) =>
    log("warn", "recall: touch failed", { err: String(err) }),
  );
  await recordRecall("");
  log("info", "recall: hit", {
    kept: kept.length, scanned: rows.length, top: kept[0].s.toFixed(3),
  });
  return (
    "Relevant past memories ([mID] = memory id, most relevant first): " +
    kept.map((x) => `[m${x.m.id}] ${truncate(x.m.text.trim(), 400)}`).join(" | ")
  );
}

async function detectAndApply(
  env: Env,
  llm: OpenAICompatible,
  updateId: number,
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
  // Accumulate machine-call usage so the ledger shows true per-turn cost.
  const used = { prompt: 0, completion: 0, total: 0 };
  const started = Date.now();
  const snapUsage = () => {
    used.prompt += llm.lastUsage.prompt;
    used.completion += llm.lastUsage.completion;
    used.total += llm.lastUsage.total;
  };
  const recordDetect = (error: string) =>
    recordTurnStat(env.DB, {
      updateId, kind: "detect", promptTokens: used.prompt, completionTokens: used.completion,
      totalTokens: used.total, model: llm.modelName, latencyMs: Date.now() - started, error,
    }).catch((e) => log("warn", "record detect stat failed", { err: String(e) }));
  let raw: string;
  let toolArgs: string | null;
  try {
    ({ text: raw, toolArgs } = await llm.generateStructured(sys, user, {
      responseFormat: { type: "json_object" },
      tools: [RECORD_STATE_TOOL as unknown as Record<string, unknown>],
    }));
    snapUsage();
  } catch (err) {
    log("warn", "detect: extraction call failed", { err: String(err) });
    await recordDetect(String(err));
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
      snapUsage();
      parsed = parseDetection(raw, open, toolArgs);
    } catch (err2) {
      log("warn", "detect: invalid extraction output", { err: String(err2) });
      await recordDetect(String(err2));
      return;
    }
  }
  const det = parsed.det;
  await recordDetect("");
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
  // Safety-net memory saves: embed + persist detector candidates the
  // mid-turn tools did not already handle. Failures only log.
  if (det.memories.length > 0) {
    const cfg =
      env.LLM_BASE_URL && env.LLM_API_KEY && env.LLM_EMBED_MODEL
        ? { baseURL: env.LLM_BASE_URL, apiKey: env.LLM_API_KEY, model: env.LLM_EMBED_MODEL }
        : null;
    let extra: Record<string, string> = {};
    if (env.LLM_EXTRA_HEADERS?.trim()) {
      try {
        extra = JSON.parse(env.LLM_EXTRA_HEADERS) as Record<string, string>;
      } catch {
        log("warn", "detect: bad extra headers, skipping memory saves");
      }
    }
    if (cfg && Object.keys(extra).length >= 0) {
      let vecs: number[][] = [];
      try {
        vecs = (await embedTexts(cfg.baseURL, cfg.apiKey, cfg.model, det.memories, extra)).vectors;
      } catch (err) {
        log("warn", "detect: memory embed failed", { err: String(err) });
      }
      for (let i = 0; i < det.memories.length && i < vecs.length; i++) {
        const text = det.memories[i] ?? "";
        const vec = vecs[i] ?? [];
        if (!text || vec.length === 0) continue;
        try {
          const id = await saveMemory(env.DB, chatId, text, vec);
          await recordFactHistory(env.DB, "memories", id, null, text, updateId).catch(() => undefined);
        } catch (err) {
          log("warn", "detect: save memory failed", { err: String(err) });
        }
      }
    }
  }
  log("info", "detect: applied", {
    loops: det.loops.length, closed: det.closeIds.length, reminders: det.reminders.length,
    profile: det.profile.length, memories: det.memories.length,
  });
}

/**
 * M3 rolling summary. When unsummarized rows pass SUMMARIZE_THRESHOLD,
 * compacts the oldest down to SUMMARIZE_KEEP_RECENT into
 * conversation_summaries and advances the watermark. Input is the prior
 * summary plus newly-aged messages only: the summary is never
 * re-summarized from scratch, and verbatim rows stay in messages (the
 * watermark only narrows the injected window).
 */
async function compactIfNeeded(
  env: Env,
  llm: OpenAICompatible,
  updateId: number,
  convId: number,
  priorSummary: string,
  log: (level: "info" | "warn" | "error", msg: string, extra?: object) => void,
): Promise<void> {
  let current;
  try {
    current = await getConversationSummary(env.DB, convId);
  } catch (err) {
    log("warn", "compact: load summary failed", { err: String(err) });
    return;
  }
  let span;
  try {
    span = await unsummarizedSpan(env.DB, convId, current.throughMessageId);
  } catch (err) {
    log("warn", "compact: span check failed", { err: String(err) });
    return;
  }
  if (span.count <= SUMMARIZE_THRESHOLD) return;
  const compactCount = span.count - SUMMARIZE_KEEP_RECENT;
  let chunk;
  try {
    chunk = await messagesChunk(env.DB, convId, current.throughMessageId, span.maxId, compactCount);
  } catch (err) {
    log("warn", "compact: load chunk failed", { err: String(err) });
    return;
  }
  if (chunk.length === 0) return;
  const lines = chunk.map((m) =>
    `${m.role === "user" ? "USER" : "COKUY"}: ${truncate(m.text.trim(), 1000)}`,
  );
  let input =
    "PRIOR SUMMARY (may be empty, trust it, do not re-derive):\n" +
    (current.summary.trim() || "(none)") +
    "\n\nNEW MESSAGES (oldest first, summarize these into the prior):\n" +
    lines.join("\n");
  input = truncate(input, 12000);
  let next: string;
  const sumStarted = Date.now();
  try {
    next = (
      await llm.generateStructured(
        "Compress chat history into one durable summary for future turns. " +
          "Keep: durable facts about the user, decisions made, promises and " +
          "open threads, stable preferences. Drop: greetings, chit-chat, " +
          "already-resolved items. Plain prose, no JSON, max 1500 characters. " +
          "Never invent facts not in the input. Reply in Indonesian when the " +
          "chat is Indonesian.",
        input,
        {},
      )
    ).text.trim();
  } catch (err) {
    log("warn", "compact: summarizer call failed", { err: String(err) });
    return;
  }
  if (!next) {
    log("warn", "compact: empty summary");
    return;
  }
  const throughId = chunk[chunk.length - 1].id;
  try {
    await upsertConversationSummary(env.DB, convId, truncate(next, SUMMARY_MAX_CHARS), throughId);
  } catch (err) {
    log("warn", "compact: save failed", { err: String(err) });
    return;
  }
  const u = llm.lastUsage;
  await recordTurnStat(env.DB, {
    updateId, kind: "summary", promptTokens: u.prompt, completionTokens: u.completion,
    totalTokens: u.total, model: llm.modelName, latencyMs: Date.now() - sumStarted, error: "",
  }).catch((err) => log("warn", "compact: record stat failed", { err: String(err) }));
  log("info", "compact: summary advanced", { through: throughId, chars: [...next].length });
}
