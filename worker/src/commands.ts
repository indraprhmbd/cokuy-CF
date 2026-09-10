// 0016 command surface: deterministic slash commands. Commands never enter
// the LLM turn; they read/write D1 directly and reply with composed text.
// Called from /telegram after the allowlist gate, inside waitUntil.

import type { Env } from "./env";
import { embedTexts } from "./embed";
import { createSender } from "./telegram";
import {
  claimUpdate,
  deleteMemoriesByKeyword,
  deleteProfileFactsByKeyword,
  getPrefs,
  markUpdateProcessed,
  recordFactHistory,
  saveMemory,
  setPrefs,
  usageSums,
  type UsageSums,
} from "./db";
import { handleToday } from "./tasks_view";

type Log = (level: "info" | "warn" | "error", msg: string, extra?: object) => void;

const WIB_OFFSET_MS = 7 * 3600 * 1000;
const DEFAULT_PRICE_IN_PER_M = 0.03;
const DEFAULT_PRICE_OUT_PER_M = 0.12;

function pricePerM(raw: string | undefined, fallback: number): number {
  const n = Number((raw ?? "").trim());
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

export interface UsageReport {
  lines: string[];
  prompt: number;
  completion: number;
  usd: number;
}

/** Shared USD math for /usage and the get_usage tool. Single source. */
export async function usageReport(env: Env, chatId: number): Promise<UsageReport> {
  const now = new Date();
  const wib = new Date(now.getTime() + WIB_OFFSET_MS);
  const day = wib.toISOString().slice(0, 10);
  const todayStart = new Date(`${day}T00:00:00+07:00`).toISOString();
  const weekStart = new Date(now.getTime() - 7 * 86400 * 1000).toISOString();
  const priceIn = pricePerM(env.PRICE_IN_PER_M, DEFAULT_PRICE_IN_PER_M);
  const priceOut = pricePerM(env.PRICE_OUT_PER_M, DEFAULT_PRICE_OUT_PER_M);
  const sum = (rows: UsageSums[]) => {
    let p = 0;
    let c = 0;
    let t = 0;
    let e = 0;
    for (const r of rows) {
      p += r.prompt;
      c += r.completion;
      t += r.turns;
      e += r.errors;
    }
    return { p, c, t, e };
  };
  const usd = (p: number, c: number) => p / 1e6 * priceIn + c / 1e6 * priceOut;
  const fmtUsd = (v: number) => `$${v.toFixed(7).replace(/0+$/, "").replace(/\.$/, ".0")}`;
  const today = sum(await usageSums(env.DB, chatId, todayStart));
  const week = sum(await usageSums(env.DB, chatId, weekStart));
  return {
    lines: [
      `Hari ini: ${today.t} panggilan, ${today.p} in / ${today.c} out token, ${fmtUsd(usd(today.p, today.c))}${today.e > 0 ? `, ${today.e} gagal` : ""}.`,
      `7 hari: ${week.t} panggilan, ${week.p} in / ${week.c} out token, ${fmtUsd(usd(week.p, week.c))}${week.e > 0 ? `, ${week.e} gagal` : ""}.`,
    ],
    prompt: week.p,
    completion: week.c,
    usd: usd(week.p, week.c),
  };
}

const HELP_TEXT =
  "Perintah gue:\n" +
  "/today — tugas hari ini\n" +
  "/brief — ringkasan sekarang\n" +
  "/usage — token + dolar minggu ini\n" +
  "/remember <fakta> — simpan ingatan\n" +
  "/forget <kata> — hapus ingatan cocok\n" +
  "/quiet [22:00-07:00] — lihat/atur jam sepi\n" +
  "Selain itu chat biasa aja, gue yang atur.";

const START_TEXT =
  "Gue Cokuy. Temen ngobrol yang ingetan + negingetin.\n\n" +
  "Gue inget fakta tentang lu, nyimpen tugas sama pengingat, " +
  "dan nongol sendiri kalau ada yang jatuh tempo. " +
  "Ketik /help buat daftar perintah.";

const QUIET_RE = /^(\d{1,2})(?::(\d{2}))?-(\d{1,2})(?::(\d{2}))?$/;
const pad2 = (n: number) => String(n).padStart(2, "0");

/** Routes one slash command. True = text was a command (handled or rejected). */
export async function handleCommand(
  env: Env,
  updateId: number,
  chatId: number,
  text: string,
  log: Log,
): Promise<boolean> {
  const trimmed = text.trimStart();
  if (!trimmed.startsWith("/")) return false;
  const sender = createSender(env);
  if (!sender) {
    log("error", "command: missing BOT_TOKEN");
    return true;
  }
  const space = trimmed.indexOf(" ");
  const cmd = (space < 0 ? trimmed : trimmed.slice(0, space)).toLowerCase();
  const arg = (space < 0 ? "" : trimmed.slice(space + 1)).trim();
  const name = cmd.slice(1).split("@")[0];
  let claimed = false;
  try {
    claimed = await claimUpdate(env.DB, updateId);
  } catch (err) {
    log("error", "command: claim failed", { err: String(err) });
    return true;
  }
  if (!claimed) {
    log("info", "command: skip duplicate update");
    return true;
  }
  const done = async () => {
    await markUpdateProcessed(env.DB, updateId).catch((err) =>
      log("error", "command: mark processed failed", { err: String(err) }),
    );
  };
  const reply = async (t: string) => {
    await sender.sendReply(chatId, t).catch((err) =>
      log("error", "command: send failed", { err: String(err) }),
    );
    await done();
  };

  if (name === "start") {
    await reply(START_TEXT);
    return true;
  }
  if (name === "help") {
    await reply(HELP_TEXT);
    return true;
  }
  if (name === "today" || name === "brief") {
    await handleToday(env, updateId, chatId, log);
    return true;
  }
  if (name === "usage") {
    try {
      const r = await usageReport(env, chatId);
      await reply(`Pemakaian lu:\n${r.lines.join("\n")}`);
    } catch (err) {
      log("error", "command: usage failed", { err: String(err) });
      await reply("Gagal ngitung pemakaian. Coba lagi ntar.");
    }
    return true;
  }
  if (name === "remember") {
    if (!arg) {
      await reply("Formatnya: /remember <fakta tentang lu>");
      return true;
    }
    if (!env.LLM_BASE_URL || !env.LLM_API_KEY || !env.LLM_EMBED_MODEL) {
      await reply("Ingatan lagi mati (embed belum dikonfigurasi).");
      return true;
    }
    let extra: Record<string, string> = {};
    if (env.LLM_EXTRA_HEADERS?.trim()) {
      try {
        extra = JSON.parse(env.LLM_EXTRA_HEADERS) as Record<string, string>;
      } catch {
        await reply("Gagal nyimpen, konfigurasi header rusak.");
        return true;
      }
    }
    try {
      const vec = (
        await embedTexts(env.LLM_BASE_URL, env.LLM_API_KEY, env.LLM_EMBED_MODEL, [arg], extra)
      ).vectors[0] ?? [];
      if (vec.length === 0) throw new Error("empty embedding");
      const id = await saveMemory(env.DB, chatId, arg.slice(0, 1000), vec);
      await recordFactHistory(env.DB, "memories", id, null, arg, updateId).catch(() => undefined);
      await reply(`Kesimpen [m${id}]. Gue inget.`);
    } catch (err) {
      log("error", "command: remember failed", { err: String(err) });
      await reply("Gagal nyimpen. Coba lagi ntar.");
    }
    return true;
  }
  if (name === "forget") {
    if (!arg) {
      await reply("Formatnya: /forget <kata kunci>");
      return true;
    }
    if ([...arg].length > 100) {
      await reply("Kata kuncinya kepanjangan, singkatin.");
      return true;
    }
    try {
      const mems = await deleteMemoriesByKeyword(env.DB, chatId, arg);
      const facts = await deleteProfileFactsByKeyword(env.DB, chatId, arg);
      const n = mems.length + facts.length;
      if (n === 0) await reply(`Nggak nemu yang cocok sama "${arg}".`);
      else {
        const shown = [...mems, ...facts].slice(0, 5).map((t) => `- ${t.slice(0, 80)}`).join("\n");
        await reply(`Dihapus ${n} ingatan:\n${shown}${n > 5 ? `\n...dan ${n - 5} lagi.` : ""}`);
      }
    } catch (err) {
      log("error", "command: forget failed", { err: String(err) });
      await reply("Gagal hapus. Coba lagi ntar.");
    }
    return true;
  }
  if (name === "quiet") {
    if (!arg) {
      try {
        const p = await getPrefs(env.DB, chatId);
        await reply(`Jam sepi lu: ${pad2(p.quietStart)}:00–${pad2(p.quietEnd)}:00. Atur: /quiet 22:00-07:00`);
      } catch (err) {
        log("error", "command: quiet read failed", { err: String(err) });
        await reply("Gagal baca jam sepi.");
      }
      return true;
    }
    const m = arg.match(QUIET_RE);
    const hh = (h: string, mi?: string) => ({ h: Number(h), m: mi === undefined ? 0 : Number(mi) });
    if (!m) {
      await reply("Formatnya: /quiet 22:00-07:00");
      return true;
    }
    const a = hh(m[1], m[2]);
    const b = hh(m[3], m[4]);
    if (a.h > 23 || b.h > 23 || a.m > 59 || b.m > 59) {
      await reply("Jamnya nggak valid (00–23, menit 00–59).");
      return true;
    }
    try {
      const p = await getPrefs(env.DB, chatId);
      await setPrefs(env.DB, chatId, a.h, b.h, p.briefTime);
      await reply(`Oke, jam sepi ${pad2(a.h)}:${pad2(a.m)}–${pad2(b.h)}:${pad2(b.m)}. Gue diem di jam itu.`);
    } catch (err) {
      log("error", "command: quiet save failed", { err: String(err) });
      await reply("Gagal nyimpen jam sepi.");
    }
    return true;
  }
  await reply("Nggak kenal perintah itu. /help buat daftar.");
  return true;
}
