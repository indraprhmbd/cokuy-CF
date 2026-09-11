// Port of internal/runtime/detect.go: post-turn extraction of open loops
// and reminder requests as strict JSON. Model output is data, never trusted
// instructions: parseDetection rejects the whole object on any violation.

import type { OpenLoop } from "./db";

export const MAX_DETECT_ITEMS = 5;
export const MAX_LOOP_TITLE_CHARS = 200;
export const MAX_LOOP_CONTEXT_CHARS = 1000;
/** Caps reminders at 30 days out. */
export const MAX_REMINDER_MINUTES = 43200;
export const MAX_PROFILE_VALUE_CHARS = 200;
export const MAX_MEMORY_TEXT_CHARS = 1000;
export const MAX_TASK_TITLE_CHARS = 200;
export const MAX_TASK_LABEL_CHARS = 32;
export const MAX_RRULE_CHARS = 100;

export interface LoopCandidate {
  title: string;
  context: string;
}

export interface ReminderCandidate {
  text: string;
  dueInMinutes: number;
}

export interface ProfileCandidate {
  key: string;
  value: string;
}

export interface Detection {
  loops: LoopCandidate[];
  closeIds: number[];
  reminders: ReminderCandidate[];
  profile: ProfileCandidate[];
  memories: string[];
  tasks: TaskCandidate[];
}

export interface TaskCandidate {
  title: string;
  dueInMinutes: number | null;
  deadlineInMinutes: number | null;
  rrule: string | null;
  label: string | null;
}

export function detectSystemPrompt(open: OpenLoop[]): string {
  let prompt =
    "You track unfinished threads and reminder requests from a chat turn. " +
    "Reply with JSON ONLY, no other text, in exactly this shape:\n" +
    '{"loops":[{"title":"short thread name","context":"one-line detail"}],' +
    '"closeIds":[1],"reminders":[{"text":"what to remind","dueInMinutes":120}],' +
    '"profile":[{"key":"language","value":"Indonesian"}],' +
    '"memories":["durable fact worth recalling later, not chit-chat"],' +
    '"tasks":[{"title":"buy milk","dueInMinutes":1440,"deadlineInMinutes":null,"rrule":null,"label":null}]}\n' +
    "Rules: loops = concrete unfinished items (promises, plans, questions awaiting action), " +
    "never chit-chat or already-answered items. closeIds = IDs below clearly resolved this turn. " +
    'reminders = ONLY explicit requests to be reminded ("remind me", "ingatkan", "ingetin", "kasih tau nanti"). ' +
    "dueInMinutes is relative to now. " +
    "profile = durable facts about the user stated or clearly shown this turn: " +
    'their name ("namaku X" -> key=name), the language they write in (key=language, e.g. Indonesian, English), ' +
    "stable preferences (key=pref.<topic>, e.g. pref.coffee). Never guess; empty when nothing stated. " +
    "memories = candidate long-term memories (facts, decisions, preferences) worth " +
    "semantic recall later; skip anything already covered by profile or chit-chat. " +
    "tasks = actionable todos with dates: title always, dueInMinutes relative " +
    "to now when a date/time is stated (null when none), deadlineInMinutes only " +
    "for hard cutoffs, rrule for repeats (every day|weekday|week|month or " +
    "every mon,fri...), label single lowercase word or null. " +
    "A reminder request (ingetin ...) is BOTH a reminder and a task. " +
    "Base extraction on the USER text: an assistant reply denying abilities " +
    "(cannot remind, no tools) is itself an error, never a reason to skip. " +
    "Empty lists when nothing qualifies.";
  if (open.length > 0) {
    prompt += "\nOpen loops:";
    for (const l of open) prompt += `\n- id=${l.id} title=${JSON.stringify(l.title)}`;
  } else {
    prompt += "\nNo open loops.";
  }
  return prompt;
}

/** Single function tool carrying the whole detector schema. Sent
 * opportunistically: gateways/models that drop `tools` fall back to the
 * prompt + brace path below, unchanged. */
export const RECORD_STATE_TOOL = {
  type: "function",
  function: {
    name: "record_state",
    description: "Record unfinished threads, resolved loop IDs, reminder requests, and durable user facts from this turn.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["loops", "closeIds", "reminders", "profile", "memories", "tasks"],
      properties: {
        loops: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["title", "context"],
            properties: { title: { type: "string" }, context: { type: "string" } },
          },
        },
        closeIds: { type: "array", items: { type: "integer" } },
        reminders: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["text", "dueInMinutes"],
            properties: { text: { type: "string" }, dueInMinutes: { type: "integer" } },
          },
        },
        profile: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["key", "value"],
            properties: { key: { type: "string" }, value: { type: "string" } },
          },
        },
        memories: { type: "array", items: { type: "string" } },
        tasks: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["title", "dueInMinutes", "deadlineInMinutes", "rrule", "label"],
            properties: {
              title: { type: "string" },
              dueInMinutes: { type: ["integer", "null"] },
              deadlineInMinutes: { type: ["integer", "null"] },
              rrule: { type: ["string", "null"] },
              label: { type: ["string", "null"] },
            },
          },
        },
      },
    },
  },
} as const;

/** MiniMax-native XML tool syntax: <minimax:tool_call><invoke
 * name="record_state"><parameter name="loops">[...]</parameter> ... */
function parseMinimaxXml(raw: string): unknown | null {
  const call = raw.match(/<minimax:tool_call>([\s\S]*?)<\/minimax:tool_call>/);
  if (!call) return null;
  const invoke = call[1].match(/<invoke\s+name="record_state">([\s\S]*?)<\/invoke>/);
  if (!invoke) return null;
  const out: Record<string, unknown> = {};
  for (const m of invoke[1].matchAll(/<parameter\s+name="([a-zA-Z]+)">([\s\S]*?)<\/parameter>/g)) {
    try {
      out[m[1]] = JSON.parse(m[2].trim());
    } catch {
      return null;
    }
  }
  return out;
}

/** Think-strip + triple-path payload: OpenAI tool args, MiniMax XML, brace-scrape. */
function extractPayload(raw: string, toolArgs: string | null): unknown {
  const stripped = raw.replace(/<think>[\s\S]*?(<\/think>|$)/g, "").trim();
  if (toolArgs?.trim()) {
    try {
      return JSON.parse(toolArgs);
    } catch {
      // fall through to text paths
    }
  }
  const xml = parseMinimaxXml(stripped);
  if (xml) return xml;
  const start = stripped.indexOf("{");
  const end = stripped.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("no JSON object found");
  try {
    return JSON.parse(stripped.slice(start, end + 1));
  } catch (err) {
    throw new Error(`unmarshal: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export interface PartialResult {
  det: Detection;
  /** Per-list counts of items dropped (not clamped) by validation. */
  dropped: { loops: number; closeIds: number; reminders: number; profile: number; memories: number; tasks: number };
}

function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

function clampRunes(s: string, max: number): string {
  const r = [...s];
  return r.length <= max ? s : r.slice(0, max).join("");
}

/**
 * Partial-accept validation: bad items are dropped (counts in `dropped`),
 * overlong strings clamped, unknown close_ids ignored. Only throws when no
 * JSON payload exists at all - callers retry once on throw.
 */
export function parseDetection(raw: string, open: OpenLoop[], toolArgs: string | null = null): PartialResult {
  const det = extractPayload(raw, toolArgs) as Record<string, unknown>;
  const dropped = { loops: 0, closeIds: 0, reminders: 0, profile: 0, memories: 0, tasks: 0 };
  const loops: LoopCandidate[] = [];
  for (const item of asArray(det.loops).slice(0, MAX_DETECT_ITEMS)) {
    const o = (item ?? {}) as Record<string, unknown>;
    const title = String(o.title ?? "").trim();
    const context = String(o.context ?? "").trim();
    if (!title) {
      dropped.loops++;
      continue;
    }
    loops.push({ title: clampRunes(title, MAX_LOOP_TITLE_CHARS), context: clampRunes(context, MAX_LOOP_CONTEXT_CHARS) });
  }
  const known = new Set(open.map((l) => l.id));
  // Be liberal in keys: accept snake_case the prompt previously taught.
  const rawClose = (det.closeIds ?? det.close_ids) as unknown;
  const closeIds: number[] = [];
  for (const id of asArray(rawClose).slice(0, MAX_DETECT_ITEMS)) {
    if (typeof id === "number" && Number.isInteger(id) && known.has(id)) closeIds.push(id);
    else dropped.closeIds++;
  }
  const reminders: ReminderCandidate[] = [];
  for (const item of asArray(det.reminders).slice(0, MAX_DETECT_ITEMS)) {
    const o = (item ?? {}) as Record<string, unknown>;
    const text = String(o.text ?? "").trim();
    // Coerce numeric strings ("5" -> 5); model often quotes numbers.
    const rawDue = (o.dueInMinutes ?? o.due_in_minutes) as unknown;
    const due = typeof rawDue === "string" && rawDue.trim() !== "" ? Number(rawDue) : rawDue;
    if (!text || !Number.isInteger(due) || (due as number) < 1 || (due as number) > MAX_REMINDER_MINUTES) {
      dropped.reminders++;
      continue;
    }
    reminders.push({ text, dueInMinutes: due as number });
  }
  const keyRe = /^(name|language|pref\.[a-z0-9_]{1,32})$/;
  const profile: ProfileCandidate[] = [];
  for (const item of asArray(det.profile).slice(0, MAX_DETECT_ITEMS)) {
    const o = (item ?? {}) as Record<string, unknown>;
    const key = String(o.key ?? "").trim();
    const value = String(o.value ?? "").trim();
    if (!keyRe.test(key) || !value) {
      dropped.profile++;
      continue;
    }
    profile.push({ key, value: clampRunes(value, MAX_PROFILE_VALUE_CHARS) });
  }
  const memories: string[] = [];
  for (const item of asArray(det.memories).slice(0, MAX_DETECT_ITEMS)) {
    const text = String(item ?? "").trim();
    if (!text) {
      dropped.memories++;
      continue;
    }
    memories.push(clampRunes(text, MAX_MEMORY_TEXT_CHARS));
  }
  const tasks: TaskCandidate[] = [];
  for (const item of asArray(det.tasks).slice(0, MAX_DETECT_ITEMS)) {
    const o = (item ?? {}) as Record<string, unknown>;
    const title = String(o.title ?? "").trim();
    if (!title) {
      dropped.tasks++;
      continue;
    }
    const due = optMinutes(o.dueInMinutes ?? o.due_in_minutes);
    const deadline = optMinutes(o.deadlineInMinutes ?? o.deadline_in_minutes);
    if ((o.dueInMinutes ?? o.due_in_minutes) != null && due == null) {
      dropped.tasks++;
      continue;
    }
    if ((o.deadlineInMinutes ?? o.deadline_in_minutes) != null && deadline == null) {
      dropped.tasks++;
      continue;
    }
    const rruleRaw = o.rrule == null ? null : String(o.rrule).trim().toLowerCase();
    const rrule = rruleRaw ? clampRunes(rruleRaw, MAX_RRULE_CHARS) : null;
    if (rrule && !/^every (day|weekday|week|month|year|[a-z,]+)( at \d{1,2}:\d{2})?$/.test(rrule)) {
      dropped.tasks++;
      continue;
    }
    const labelRaw = o.label == null ? null : String(o.label).trim().toLowerCase();
    const label = labelRaw ? clampRunes(labelRaw, MAX_TASK_LABEL_CHARS) : null;
    if (label && !/^[a-z0-9_]+$/.test(label)) {
      dropped.tasks++;
      continue;
    }
    tasks.push({ title: clampRunes(title, MAX_TASK_TITLE_CHARS), dueInMinutes: due, deadlineInMinutes: deadline, rrule, label });
  }
  return { det: { loops, closeIds, reminders, profile, memories, tasks }, dropped };
}

/** Optional relative-minutes field: null stays null, numeric strings coerce, out-of-range drops. */
function optMinutes(v: unknown): number | null {
  if (v == null) return null;
  const n = typeof v === "string" && v.trim() !== "" ? Number(v) : v;
  if (!Number.isInteger(n) || (n as number) < 1 || (n as number) > MAX_REMINDER_MINUTES) return null;
  return n as number;
}
