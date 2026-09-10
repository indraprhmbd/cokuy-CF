// 0013 Sprint 2: memory-as-tools. Mid-turn function tools letting the
// model recall and persist memories itself instead of relying only on the
// post-turn detector. Every executor validates args, scopes writes by
// chat_id, and audits mutations to fact_history. Unknown tool names and
// invalid shapes return errors as tool results (never throw into the loop).

import type { Env } from "./env";
import { cosine, embedTexts } from "./embed";
import { usageReport } from "./commands";
import {
  memoriesForChat,
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

export const USAGE_TOOL = {
  type: "function",
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

export const MEMORY_TOOLS = [RECALL_TOOL, SAVE_FACT_TOOL, UPDATE_FACT_TOOL, USAGE_TOOL];

export const MEMORY_TOOL_GUIDE =
  "Memory tools: call recall_memories when you need past context not in " +
  "this conversation; call save_fact when the user states a durable " +
  "preference, identity detail, or decision (one fact per call, never " +
  "chit-chat); call update_fact with the [mID] when the user corrects a " +
  "stored memory. Never invent memory IDs; call get_usage when the user " +
  "asks about token usage or cost.";

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
    let qv: number[];
    try {
      qv = (await embedTexts(cfg.baseURL, cfg.apiKey, cfg.model, [query], cfg.extra)).vectors[0] ?? [];
    } catch (err) {
      return `error: embed failed: ${err instanceof Error ? err.message : String(err)}`;
    }
    const rows = await memoriesForChat(env.DB, chatId, 2000);
    const hits = rows
      .map((m) => ({ m, s: cosine(qv, m.embedding) }))
      .filter((x) => x.s >= TOOL_THRESHOLD)
      .sort((a, b) => b.s - a.s)
      .slice(0, k)
      .map((x) => ({ id: x.m.id, text: x.m.text, score: Math.round(x.s * 1000) / 1000 }));
    return JSON.stringify(hits);
  }
  if (name === "save_fact") {
    const text = typeof args["text"] === "string" ? args["text"].trim() : "";
    if (!text) return "error: text is empty";
    const cfg = embedCfg(env);
    if (!cfg) return "error: embeddings unconfigured";
    let vec: number[];
    try {
      vec = (await embedTexts(cfg.baseURL, cfg.apiKey, cfg.model, [text], cfg.extra)).vectors[0] ?? [];
    } catch (err) {
      return `error: embed failed: ${err instanceof Error ? err.message : String(err)}`;
    }
    if (vec.length === 0) return "error: empty embedding";
    const id = await saveMemory(env.DB, chatId, clampRunes(text, MAX_FACT_CHARS), vec);
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
    let vec: number[];
    try {
      vec = (await embedTexts(cfg.baseURL, cfg.apiKey, cfg.model, [text], cfg.extra)).vectors[0] ?? [];
    } catch (err) {
      return `error: embed failed: ${err instanceof Error ? err.message : String(err)}`;
    }
    if (vec.length === 0) return "error: empty embedding";
    await updateMemory(env.DB, cur.id, chatId, clampRunes(text, MAX_FACT_CHARS), vec);
    await recordFactHistory(env.DB, "memories", cur.id, cur.text, text, updateId).catch(() => undefined);
    return JSON.stringify({ updated_id: cur.id });
  }
  if (name === "get_usage") {
    try {
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
  return `error: unknown tool ${name}`;
}
