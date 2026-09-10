// QA burn script: fires test updates at the worker (mimics your Telegram ID),
// polls replies, then reports tokens/latency/USD per question + totals.
// Run: node tools/qa-burn.ts [--url ..] [--secret ..] [--user ..] [--seed]
// Env fallback: COKUY_URL, COKUY_SECRET, COKUY_USER, COKUY_LLM_KEY (seed only),
// COKUY_LLM_BASE (seed only, default https://ai.sumopod.com/v1).
// D1 reads go through `npx wrangler d1 execute` (run from worker/).
import { execFileSync } from "node:child_process";

interface Args {
  url: string;
  secret: string;
  user: number;
  seed: boolean;
  /** Seconds to wait between questions (rate kindness). */
  gap: number;
}

const CHAT_IN_PER_M = 0.03;
const CHAT_OUT_PER_M = 0.12;
const EMB_PER_M = 0.02;

const QUESTIONS: string[] = [
  "halo cokuy, lagi apa?",
  "enak sarapan apa ya?",
  "namaku arsya, ingat ya",
  "sukanya kopi pahit, jangan manis",
  "ingetin gue 2 menit lagi buat matiin lampu",
  "minuman favorit gue apa?",
  "ok thanks",
  "bukan itu maksud gue, yang hangat-hangat",
  "yg praktis sih",
  "sipp, santai aja",
];

const SEED_MEMORIES: string[] = [
  "User suka kopi pahit, jangan manis.",
  "User bernama Arsya, berbahasa Indonesia kasual.",
  "User sering begadang dan butuh pengingat matiin lampu.",
  "User suka sarapan praktis seperti roti atau mie instan.",
  "User tidak suka jawaban formal, maunya gaya gue/lu.",
];

function parseArgs(): Args {
  const a = process.argv.slice(2);
  const get = (k: string): string | undefined => {
    const i = a.indexOf(k);
    return i >= 0 && i + 1 < a.length ? a[i + 1] : undefined;
  };
  const url = get("--url") ?? process.env["COKUY_URL"];
  const secret = get("--secret") ?? process.env["COKUY_SECRET"];
  const userRaw = get("--user") ?? process.env["COKUY_USER"];
  if (!url || !secret || !userRaw) {
    console.error("need --url --secret --user (or COKUY_URL/COKUY_SECRET/COKUY_USER)");
    process.exit(1);
  }
  const gapRaw = get("--gap") ?? "15";
  const gap = Number(gapRaw);
  if (!Number.isFinite(gap) || gap < 0) {
    console.error("--gap must be seconds >= 0");
    process.exit(1);
  }
  return { url, secret, user: Number(userRaw), seed: a.includes("--seed"), gap };
}

function d1(cmd: string): unknown[] {
  // shell:true (Windows npx shim) word-splits args, so quote the SQL.
  const out = execFileSync(
    "npx",
    ["wrangler", "d1", "execute", "cokuy-cf", "--remote", "--command", `"${cmd}"`, "--json"],
    { encoding: "utf8", maxBuffer: 16 * 1024 * 1024, shell: true },
  );
  const parsed = JSON.parse(out) as Array<{ results?: unknown[] }>;
  return parsed[0]?.results ?? [];
}

function sqlStr(s: string): string {
  return "'" + s.replace(/'/g, "''") + "'";
}

async function seedMemories(user: number): Promise<void> {
  const key = process.env["COKUY_LLM_KEY"];
  const base = (process.env["COKUY_LLM_BASE"] ?? "https://ai.sumopod.com/v1").replace(/\/+$/, "");
  if (!key) {
    console.error("seed needs COKUY_LLM_KEY");
    process.exit(1);
  }
  console.log("seeding", SEED_MEMORIES.length, "memories...");
  const res = await fetch(base + "/embeddings", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + key },
    body: JSON.stringify({ model: "text-embedding-3-small", input: SEED_MEMORIES }),
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) throw new Error("seed embed HTTP " + res.status);
  const body = (await res.json()) as { data?: Array<{ embedding?: number[] }> };
  if (!Array.isArray(body.data) || body.data.length !== SEED_MEMORIES.length) {
    throw new Error("seed embed bad shape");
  }
  body.data.forEach((d, i) => {
    if (!Array.isArray(d.embedding) || d.embedding.length === 0) throw new Error("seed bad vector " + i);
  });
  // --file, not --command: one embedding JSON (~12KB) already exceeds the
  // Windows 8k command-line limit.
  const fs = await import("node:fs");
  const path = "_temp_seed_mem.sql";
  const sql = body.data
    .map(
      (d, i) =>
        `INSERT INTO memories(chat_id, text, embedding) VALUES (${user}, ${sqlStr(SEED_MEMORIES[i] ?? "")}, ${sqlStr(JSON.stringify(d.embedding))});`,
    )
    .join("\n");
  fs.writeFileSync(path, sql);
  try {
    execFileSync("npx", ["wrangler", "d1", "execute", "cokuy-cf", "--remote", "--file", path, "--json"], {
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
      shell: true,
    });
  } finally {
    fs.rmSync(path, { force: true });
  }
  console.log("seed done.");
}

async function sendUpdate(url: string, secret: string, user: number, updateId: number, text: string): Promise<void> {
  const res = await fetch(url + "/telegram", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-telegram-bot-api-secret-token": secret,
    },
    body: JSON.stringify({
      update_id: updateId,
      message: {
        message_id: updateId,
        from: { id: user },
        chat: { id: user },
        text,
      },
    }),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error("send HTTP " + res.status + " for update " + updateId);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitReply(afterId: number, timeoutMs: number): Promise<string> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const rows = d1(
      `SELECT id, text FROM messages WHERE id > ${afterId} AND role = 'assistant' ORDER BY id ASC LIMIT 1;`,
    ) as Array<{ id: number; text: string }>;
    if (rows.length > 0) return rows[0]?.text ?? "";
    await sleep(3000);
  }
  return "";
}

interface StatRow {
  update_id: number;
  kind: string;
  prompt_tokens: number;
  completion_tokens: number;
  latency_ms: number;
  error: string;
}

async function main(): Promise<void> {
  const args = parseArgs();
  if (args.seed) await seedMemories(args.user);

  const maxRow = d1("SELECT COALESCE(MAX(id),0) AS n FROM messages;") as Array<{ n: number }>;
  let afterId = maxRow[0]?.n ?? 0;
  const base = 900000000 + Math.floor(Date.now() / 1000) % 100000;
  console.log("firing", QUESTIONS.length, "questions as user", args.user);

  const replies: string[] = [];
  for (let i = 0; i < QUESTIONS.length; i++) {
    const q = QUESTIONS[i] ?? "";
    const uid = base + i;
    console.log(`\n[${i + 1}/${QUESTIONS.length}] Q: ${q}`);
    await sendUpdate(args.url, args.secret, args.user, uid, q);
    const reply = await waitReply(afterId, 90000);
    if (!reply) {
      console.log("  (no reply in 90s)");
      replies.push("");
      continue;
    }
    const cur = d1(`SELECT COALESCE(MAX(id),0) AS n FROM messages;`) as Array<{ n: number }>;
    afterId = cur[0]?.n ?? afterId;
    console.log("  A: " + reply.slice(0, 300));
    replies.push(reply);
    if (i + 1 < QUESTIONS.length && args.gap > 0) {
      console.log(`  (gap ${args.gap}s)`);
      await sleep(args.gap * 1000);
    }
  }

  const ids = QUESTIONS.map((_, i) => base + i).join(",");
  const stats = d1(
    `SELECT update_id, kind, prompt_tokens, completion_tokens, latency_ms, error FROM turn_stats WHERE update_id IN (${ids}) ORDER BY update_id, kind;`,
  ) as StatRow[];

  let totIn = 0;
  let totOut = 0;
  let totEmb = 0;
  let errCount = 0;
  console.log("\n--- per-question ledger ---");
  QUESTIONS.forEach((q, i) => {
    const uid = base + i;
    const rows = stats.filter((s) => s.update_id === uid);
    let qi = 0;
    let qo = 0;
    for (const r of rows) {
      if (r.kind === "recall") totEmb += r.prompt_tokens;
      else {
        totIn += r.prompt_tokens;
        totOut += r.completion_tokens;
      }
      qi += r.kind === "recall" ? 0 : r.prompt_tokens;
      qo += r.kind === "recall" ? 0 : r.completion_tokens;
      if (r.error) errCount++;
    }
    const reply = replies[i] ?? "";
    const formal = /saya|Anda/i.test(reply) ? " FORMAL!" : "";
    console.log(`Q${i + 1} tok_in=${qi} tok_out=${qo} kinds=[${rows.map((r) => r.kind).join(",")}]${formal}`);
  });

  const usd = ((totIn * CHAT_IN_PER_M + totOut * CHAT_OUT_PER_M + totEmb * EMB_PER_M) / 1_000_000);
  console.log("\n--- totals ---");
  console.log(`tok_in=${totIn} tok_out=${totOut} embed_in=${totEmb} errors=${errCount}`);
  console.log(`usd=${usd.toFixed(7)} for ${QUESTIONS.length} QnA`);
}

main().catch((e) => {
  console.error("FATAL", e instanceof Error ? e.message : String(e));
  process.exit(1);
});
