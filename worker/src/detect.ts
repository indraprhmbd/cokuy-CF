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
}

export function detectSystemPrompt(open: OpenLoop[]): string {
  let prompt =
    "You track unfinished threads and reminder requests from a chat turn. " +
    "Reply with JSON ONLY, no other text, in exactly this shape:\n" +
    '{"loops":[{"title":"short thread name","context":"one-line detail"}],' +
    '"closeIds":[1],"reminders":[{"text":"what to remind","dueInMinutes":120}],' +
    '"profile":[{"key":"language","value":"Indonesian"}]}\n' +
    "Rules: loops = concrete unfinished items (promises, plans, questions awaiting action), " +
    "never chit-chat or already-answered items. closeIds = IDs below clearly resolved this turn. " +
    'reminders = ONLY explicit requests to be reminded ("remind me", "ingatkan", "ingetin", "kasih tau nanti"). ' +
    "dueInMinutes is relative to now. " +
    "profile = durable facts about the user stated or clearly shown this turn: " +
    'their name ("namaku X" -> key=name), the language they write in (key=language, e.g. Indonesian, English), ' +
    "stable preferences (key=pref.<topic>, e.g. pref.coffee). Never guess; empty when nothing stated. " +
    "Empty lists when nothing qualifies.";
  if (open.length > 0) {
    prompt += "\nOpen loops:";
    for (const l of open) prompt += `\n- id=${l.id} title=${JSON.stringify(l.title)}`;
  } else {
    prompt += "\nNo open loops.";
  }
  return prompt;
}

/** Extracts the JSON object from raw output and validates every field. Wholesale reject on any flaw. */
export function parseDetection(raw: string, open: OpenLoop[]): Detection {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("no JSON object found");
  let det: Detection;
  try {
    det = JSON.parse(raw.slice(start, end + 1)) as Detection;
  } catch (err) {
    throw new Error(`unmarshal: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!Array.isArray(det.loops)) det.loops = [];
  // Be liberal in keys: accept snake_case the prompt previously taught.
  const rawClose = (det as { closeIds?: unknown; close_ids?: unknown }).closeIds ??
    (det as { close_ids?: unknown }).close_ids;
  det.closeIds = Array.isArray(rawClose) ? rawClose as number[] : [];
  if (!Array.isArray(det.reminders)) det.reminders = [];
  if (!Array.isArray(det.profile)) det.profile = [];
  if (
    det.loops.length > MAX_DETECT_ITEMS ||
    det.reminders.length > MAX_DETECT_ITEMS ||
    det.closeIds.length > MAX_DETECT_ITEMS ||
    det.profile.length > MAX_DETECT_ITEMS
  ) {
    throw new Error(`list exceeds cap of ${MAX_DETECT_ITEMS}`);
  }
  for (let i = 0; i < det.loops.length; i++) {
    const title = (det.loops[i].title ?? "").trim();
    const context = (det.loops[i].context ?? "").trim();
    if (!title) throw new Error(`loop ${i}: empty title`);
    if ([...title].length > MAX_LOOP_TITLE_CHARS) throw new Error(`loop ${i}: title too long`);
    if ([...context].length > MAX_LOOP_CONTEXT_CHARS) throw new Error(`loop ${i}: context too long`);
    det.loops[i] = { title, context };
  }
  const known = new Set(open.map((l) => l.id));
  for (const id of det.closeIds) {
    if (!known.has(id)) throw new Error(`close_id ${id} not open`);
  }
  for (let i = 0; i < det.reminders.length; i++) {
    const text = (det.reminders[i].text ?? "").trim();
    // Coerce numeric strings ("5" -> 5); model often quotes numbers.
    const rawDue = (det.reminders[i] as { dueInMinutes?: unknown; due_in_minutes?: unknown }).dueInMinutes ??
      (det.reminders[i] as { due_in_minutes?: unknown }).due_in_minutes;
    const due = typeof rawDue === "string" && rawDue.trim() !== "" ? Number(rawDue) : rawDue;
    if (!text) throw new Error(`reminder ${i}: empty text`);
    if (!Number.isInteger(due) || (due as number) < 1 || (due as number) > MAX_REMINDER_MINUTES) {
      throw new Error(`reminder ${i}: dueInMinutes out of range`);
    }
    det.reminders[i] = { text, dueInMinutes: due as number };
  }
  const keyRe = /^(name|language|pref\.[a-z0-9_]{1,32})$/;
  for (let i = 0; i < det.profile.length; i++) {
    const key = (det.profile[i].key ?? "").trim();
    const value = (det.profile[i].value ?? "").trim();
    if (!keyRe.test(key)) throw new Error(`profile ${i}: bad key ${JSON.stringify(key)}`);
    if (!value) throw new Error(`profile ${i}: empty value`);
    if ([...value].length > MAX_PROFILE_VALUE_CHARS) throw new Error(`profile ${i}: value too long`);
    det.profile[i] = { key, value };
  }
  return det;
}
