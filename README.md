# Cokuy CF

A deliberately modest personal Telegram agent on Cloudflare's free tier:
not the smartest guy in the circle, but usually around, kind, willing to
help, and careful not to pretend it knows more than it does.

The interesting part is not maximizing model intelligence — it is a
**persistent** agent that stays useful, coherent, and cheap on small
infrastructure. TypeScript + Hono + D1, one Worker, ~$0/mo.

## How it works

```
Telegram webhook → Worker (Hono) → turn pipeline → LLM (OpenAI-compatible) → Telegram reply
                        │                    ├── tools: save/update/search memory, record state
                        │                    └── recall: FTS5 keywords + cosine vectors, RRF-merged
                        └── cron * * * * * → reminders, nudges, outbox drain (quiet hours + caps)
```

- **Transport**: Telegram webhook (`/telegram`, `secret_token` verified), grammY as Bot API client only.
- **Runtime**: `worker/src/` — `index.ts` (routes), `turn.ts` (chat turn + recall), `detect.ts` (reminder/nudge detector + tool-call parsing), `tick.ts` (proactive scheduler), `memory_tools.ts`, `commands.ts` (`/start /help /today /brief /usage /remember /forget /quiet`), `tasks_view.ts`, `sanitize.ts`, `llm.ts`, `embed.ts`, `db.ts`, `telegram.ts`, `env.ts`.
- **Storage**: D1 (`cokuy-cf`), 15 migrations in `worker/migrations/` — memories (BLOB embeddings + FTS5 side table), profile facts, tasks, reminders, outbox, turn stats, conversation summaries.
- **Inference**: any OpenAI-compatible endpoint via env vars. Default: MiniMax through a Cloudflare AI Gateway. Embeddings truncated to 256-d, unit-normed, stored as Float32 BLOBs.
- **Auth**: Telegram allowlist (`ALLOWED_USER_IDS`), fail-closed; strangers silently dropped.

## Quickstart (10 min)

Prereqs: Node 18+, a Cloudflare account, a Telegram bot token (`@BotFather`), an OpenAI-compatible LLM key.

```bash
cd worker
npm install
cp .dev.vars.example .dev.vars   # fill in real values (never committed)

# local D1 + dev loop
npx wrangler d1 migrations apply cokuy-cf --local
npx wrangler dev

# ship it
npx wrangler d1 migrations apply cokuy-cf --remote
npx wrangler deploy --var ALLOWED_USER_IDS:"<id1>,<id2>" \
  --var LLM_BASE_URL:"<gateway-or-provider-url>"
npx wrangler secret put BOT_TOKEN
npx wrangler secret put LLM_API_KEY
npx wrangler secret put TELEGRAM_WEBHOOK_SECRET
# point Telegram at the worker:
# https://api.telegram.org/bot<TOKEN>/setWebhook?url=<WORKER_URL>/telegram \
#   &secret_token=<SECRET>&allowed_updates=["message","callback_query"]
```

Verify before every deploy: `npx tsc --noEmit`, then exercise recall/memory paths against local D1. See `CONTRIBUTING.md`.

## Commands

`/start /help /today /brief /usage /remember <text> /forget <keyword> /quiet [on|off]` — plus inline task buttons (`/today`) with callback queries.

## Cost

Designed for Cloudflare Free: per-minute cron tick is ~10 indexed D1 reads (~15k/day vs 5M quota); one embed call + one chat call per message turn. `/usage` reports per-chat spend from the turn ledger.

## Decisions, not just code

Architecture lives in `docs/decisions/` (18 docs: memory-as-tools, FTS5+RRF hybrid recall, usage ledger, learning loops, …). `docs/context/` holds the product/persistence/security snapshots. Read them before changing behavior — and record new decisions there (see `CONTRIBUTING.md`, `AGENTS.md`).

## Project rule

Treat awkward ideas as experiments. An unusual or anti-pattern choice is acceptable when it is deliberate, bounded, measurable, and reversible.

## License

MIT — see `LICENSE`.
