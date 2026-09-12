// 0013 Sprint 2: memory-as-tools. Mid-turn function tools letting the
// model recall and persist memories itself instead of relying only on the
// post-turn detector. Every executor validates args, scopes writes by
// chat_id, and audits mutations to fact_history. Unknown tool names and
// invalid shapes return errors as tool results (never throw into the loop).

import type { Env } from "./env";
import { bytesToF32, cosine, dot, embedDims, embedTexts, f32ToBytes, toUnitVec } from "./embed";
import { usageReport } from "./commands";
import {
  backfillEmb,
  createReminder,
  memoriesForChat,
  memoriesForRecall,
  recordFactHistory,
  saveMemory,
  updateMemory,
} from "./db";

export const RECALL_TOOL = {
  type: "function",
  function: {
    name: "recall_memories",
    description:
      "Search long-term memories for context relevant to the current turn. Returns id/text/score JSON.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["query"],
      properties: {
        query: { type: "string" },
        k: { type: "integer" },
      },
    },
  },
};

export const SAVE_FACT_TOOL = {
  type: "function",
  function: {
    name: "save_fact",
    description:
      "Persist one durable fact about the user (preference, identity detail, decision). Call when the user states something worth remembering across turns.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["text"],
      properties: { text: { type: "string" } },
    },
  },
};

export const UPDATE_FACT_TOOL = {
  type: "function",
  function: {
    name: "update_fact",
    description:
      "Correct a stored memory by id when the user revises it. The old text stays in the audit trail.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["id", "text", "reason"],
      properties: {
        id: { type: "integer" },
        text: { type: "string" },
        reason: { type: "string" },
      },
    },
  },
};

export const USAGE_TOOL = {  type: "function",
  function: {
    name: "get_usage",
    description:
      "Read this chat's token usage and cost (today + 7 days) from the usage ledger. Call when the user asks about cost, tokens, or pemakaian.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: [],
      properties: {},
    },
  },
};

export const SET_REMINDER_TOOL = {
  type: "function",
  function: {
    name: "set_reminder",
    description:
      "Set a reminder that WILL be delivered to this chat. Call the moment the user asks to be reminded (ingetin ... menit/jam lagi). The reminder fires even if the user is idle. dueInMinutes is relative to now.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["text", "dueInMinutes"],
      properties: {
        text: { type: "string" },
        dueInMinutes: { type: "integer" },
      },
    },
  },
};

export const MEMORY_TOOLS = [RECALL_TOOL, SAVE_FACT_TOOL, UPDATE_FACT_TOOL, USAGE_TOOL, SET_REMINDER_TOOL];

export const MEMORY_TOOL_GUIDE =
  "Memory tools: call recall_memories when you need past context not in " +
  "this conversation; call save_fact when the user states a durable " +
  "preference, identity detail, or decision (one fact per call, never " +
  "chit-chat); call update_fact with the [mID] when the user corrects a " +
  "stored memory. Never invent memory IDs; call get_usage when the user " +
  "asks about token usage or cost; call set_reminder the moment the user " +
  "asks to be reminded, it WILL be delivered, never claim otherwise.";

const MAX_FACT_CHARS = 1000;
const TOOL_TOP_K = 5;
const TOOL_THRESHOLD = 0.6;

function clampRunes(s: string, max: number): string {
  const r = [...s];
  return r.length <= max ? s : r.slice(0, max).join("");
}

function embedCfg(env: Env): { baseURL: string; apiKey: string; model: string; extra: Record<string, string> } | null {
  if (!env.LLM_BASE_URL || !env.LLM_API_KEY || !env.LLM_EMBED_MODEL) return null;
  let extra: Record<string, string> = {};
  if (env.LLM_EXTRA_HEADERS?.trim()) {
    try {
      extra = JSON.parse(env.LLM_EXTRA_HEADERS) as Record<string, string>;
    } catch {
      return null;
    }
  }
  return { baseURL: env.LLM_BASE_URL, apiKey: env.LLM_API_KEY, model: env.LLM_EMBED_MODEL, extra };
}

/** Executes one memory tool call. Returns the tool-result string. */
export async function executeMemoryTool(
  env: Env,
  chatId: number,
  updateId: number,
  name: string,
  rawArgs: string,
): Promise<string> {
  let args: Record<string, unknown>;
  try {
    args = JSON.parse(rawArgs) as Record<string, unknown>;
  } catch {
    return "error: args are not valid JSON";
  }
  if (name === "recall_memories") {
    const query = typeof args["query"] === "string" ? args["query"].trim() : "";
    if (!query) return "error: query is empty";
    const kRaw = args["k"];
    const k = typeof kRaw === "number" && Number.isInteger(kRaw) ? Math.min(Math.max(kRaw, 1), TOOL_TOP_K) : TOOL_TOP_K;
    const cfg = embedCfg(env);
    if (!cfg) return "error: embeddings unconfigured";
    const dims = embedDims(env.LLM_EMBED_DIMS);
    let qv: Float32Array;
    try {
      const r = await embedTexts(cfg.baseURL, cfg.apiKey, cfg.model, [query], cfg.extra, dims);
      qv = toUnitVec(r.vectors[0] ?? [], dims);
    } catch (err) {
      return `error: embed failed: ${err instanceof Error ? err.message : String(err)}`;
    }
    const { rows } = await memoriesForRecall(env.DB, chatId, 500);
    const hits: Array<{ id: number; text: string; score: number }> = [];
    for (const m of rows) {
      let v = bytesToF32(m.emb);
      if (!v && m.legacy) {
        try {
          const arr = JSON.parse(m.legacy) as unknown;
          if (Array.isArray(arr) && arr.length > 0) {
            v = toUnitVec(arr as number[], dims);
            await backfillEmb(env.DB, m.id, f32ToBytes(v)).catch(() => undefined);
          }
        } catch {
          continue;
        }
      }
      if (!v) continue;
      const s = dot(qv, v);
      if (s >= TOOL_THRESHOLD) hits.push({ id: m.id, text: m.text, score: Math.round(s * 1000) / 1000 });
    }
    hits.sort((a, b) => b.score - a.score);
    return JSON.stringify(hits.slice(0, k));
  }
  if (name === "save_fact") {
    const text = typeof args["text"] === "string" ? args["text"].trim() : "";
    if (!text) return "error: text is empty";
    const cfg = embedCfg(env);
    if (!cfg) return "error: embeddings unconfigured";
    const dims = embedDims(env.LLM_EMBED_DIMS);
    let vec: number[];
    try {
      vec = (await embedTexts(cfg.baseURL, cfg.apiKey, cfg.model, [text], cfg.extra, dims)).vectors[0] ?? [];
    } catch (err) {
      return `error: embed failed: ${err instanceof Error ? err.message : String(err)}`;
    }
    if (vec.length === 0) return "error: empty embedding";
    const id = await saveMemory(env.DB, chatId, clampRunes(text, MAX_FACT_CHARS), vec, dims);
    await recordFactHistory(env.DB, "memories", id, null, text, updateId).catch(() => undefined);
    return JSON.stringify({ saved_id: id });
  }
  if (name === "update_fact") {
    const id = args["id"];
    const text = typeof args["text"] === "string" ? args["text"].trim() : "";
    const reason = typeof args["reason"] === "string" ? args["reason"].trim() : "";
    if (!Number.isInteger(id) || (id as number) <= 0) return "error: id must be a positive integer memory id";
    if (!text) return "error: text is empty";
    if (!reason) return "error: reason is required (why is the old memory wrong?)";
    const cfg = embedCfg(env);
    if (!cfg) return "error: embeddings unconfigured";
    const rows = await memoriesForChat(env.DB, chatId, 2000);
    const cur = rows.find((r) => r.id === (id as number));
    if (!cur) return "error: no memory with that id for this chat";
    const dims = embedDims(env.LLM_EMBED_DIMS);
    let vec: number[];
    try {
      vec = (await embedTexts(cfg.baseURL, cfg.apiKey, cfg.model, [text], cfg.extra, dims)).vectors[0] ?? [];
    } catch (err) {
      return `error: embed failed: ${err instanceof Error ? err.message : String(err)}`;
    }
    if (vec.length === 0) return "error: empty embedding";
    await updateMemory(env.DB, cur.id, chatId, clampRunes(text, MAX_FACT_CHARS), vec, dims);
    await recordFactHistory(env.DB, "memories", cur.id, cur.text, text, updateId).catch(() => undefined);
    return JSON.stringify({ updated_id: cur.id });
  }
  if (name === "get_usage") {    try {
      const r = await usageReport(env, chatId);
      return JSON.stringify({
        lines: r.lines,
        prompt_tokens_7d: r.prompt,
        completion_tokens_7d: r.completion,
        usd_7d: Math.round(r.usd * 1e7) / 1e7,
      });
    } catch (err) {
      return `error: usage read failed: ${err instanceof Error ? err.message : String(err)}`;
    }
  }
  if (name === "set_reminder") {
    const text = typeof args["text"] === "string" ? args["text"].trim() : "";
    const dueRaw = args["dueInMinutes"];
    const due = typeof dueRaw === "string" && dueRaw.trim() !== "" ? Number(dueRaw) : dueRaw;
    if (!text) return "error: text is empty";
    if (!Number.isInteger(due) || (due as number) < 1 || (due as number) > 43200) {
      return "error: dueInMinutes must be an integer 1..43200 (minutes from now)";
    }
    // Same minute-truncated due as the detector path: redelivery-safe.
    const dueAt = new Date(Date.now() + (due as number) * 60000);
    dueAt.setSeconds(0, 0);
    try {
      const id = await createReminder(env.DB, chatId, clampRunes(text, MAX_FACT_CHARS), dueAt);
      return JSON.stringify({ reminder_id: id, due_at: dueAt.toISOString() });
    } catch (err) {
      return `error: create reminder failed: ${err instanceof Error ? err.message : String(err)}`;
    }
  }
  return `error: unknown tool ${name}`;
}
