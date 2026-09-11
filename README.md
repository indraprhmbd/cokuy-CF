# Cokuy CF

[![license](https://img.shields.io/badge/license-MIT-green)](LICENSE)
[![worker](https://img.shields.io/badge/worker-cloudflare-F38020?logo=cloudflare)](worker/wrangler.jsonc)
[![db](https://img.shields.io/badge/db-D1-F38020)](worker/migrations/)

Cokuy is a deliberately modest personal agent: not the smartest guy in the circle, but usually around, kind, willing to help, and careful not to pretend it knows more than it does.

This is not the agent that will write your thesis, outsmart your coworkers, or pass itself off as a genius. It is the one that remembers you asked it to remind you, pings you when the quiet hours end, keeps your loops open until they are actually closed, and tells you straight when it does not know. Small model, free tier, zero bill. Surprisingly loyal memory for something that cheap.

The project is an open-source engineering playground. The interesting part is not maximizing model intelligence; it is building a persistent agent that stays useful, coherent, cheap, and reliable on small infrastructure. Cokuy is the first of a small family of sibling agents built on the same principles.

## Core idea

**Persistent, not necessarily smart.**

Open loops are first-class state. Tasks, reminders, and nudges live in structured tables, not buried in chat transcripts. History retrieval is a fallback, not the memory architecture. The core state must outlive model swaps, provider changes, and rewrites, from a Go binary on a tiny VPS to this Cloudflare Worker on the free tier.

| Aspect | Usual agents | Cokuy CF |
|---|---|---|
| Brain | Smartest model, biggest bill | Small cheap model, persistence does heavy lifting |
| Infra | Docker + Postgres + Redis + queue | One Worker + one D1 database |
| Transport | Webhook + public URL + TLS to manage | Webhook + secret token, CF handles TLS |
| Memory | Vector DB + embeddings | Structured tables; FTS5 keywords + cosine vectors, RRF-merged, fallback only |
| Tools | Run inline during chat | Mid-turn memory tools + outbox + scheduler |
| Reminders | Cron SaaS or plugins | Rows + 1 min tick, quiet 22:00-07:00 WIB |
| Access | Multi user SaaS auth | Allowlist IDs, strangers get silence |
| Codebase | LangChain / agents SDK | Hono + grammY client + raw SQL, no framework |
| Cost | Unknown until invoice | Per turn tokens logged, `/usage` included |
| Models | Swap = rewrite prompts | Base URL + key swap, state outlives model |
| Server | Needs 2GB+ VPS | Free tier Worker, $0/mo by design |

## What it can do

* Chat over Telegram, locked to an allowlist by numeric ID. Strangers get silence, not an error message.
* Remember conversation per chat and answer with recent context under a fixed character budget.
* Save and recall memories mid-turn through tools, with keyword (FTS5) + vector recall fused by RRF.
* Detect open loops from normal conversation ("remind me in 20 minutes", "I still owe Budi an answer") and store them as structured state.
* Deliver reminders and follow-up nudges on its own, through a scheduler tick, with quiet hours respected (22:00 to 07:00 WIB, Asia/Jakarta).
* Cap outbound nudges per chat per day so it never spams you.
* Survive restarts and redeliveries: every Telegram update is claimed exactly once before it takes effect.
* Report its own spend: token usage per turn via `/usage`, observability through the CF dashboard.

## How it works

One bounded turn per message: allowlist check, claim update, load recent history, recall memories, call the model with memory tools, persist both sides, detect loops and reminders, reply. A separate tick every minute flushes due reminders, drafts nudges for stale loops, and drains an outbox with quiet-hours gating and a daily cap. D1 holds everything; the schema is the memory.

The model is a replaceable runtime component. Any OpenAI-compatible endpoint works through a single base URL plus key swap. The default setup runs MiniMax M2.7 highspeed through Sumopod via a Cloudflare AI Gateway at promo pricing, but nothing in the architecture cares which provider answers.

```
Telegram webhook → Worker (Hono) → turn pipeline → LLM (OpenAI-compatible) → Telegram reply
                        │                    ├── tools: save/update/search memory, record state
                        │                    └── recall: FTS5 keywords + cosine vectors, RRF-merged
                        └── cron * * * * * → reminders, nudges, outbox drain (quiet hours + caps)
```

## Try it

You need Node 18+, a Cloudflare account, a Telegram bot token (@BotFather), your numeric Telegram ID (ask @userinfobot), and any OpenAI-compatible API key.

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

Then send your bot a message on Telegram. `/usage` reports spend, `/today` shows open loops. Verify before every deploy: `npx tsc --noEmit` plus a local-D1 exercise of the touched path. Details are in CONTRIBUTING.md, SECURITY.md, and `docs/decisions/`.

## Status and siblings

This repo is the Cloudflare sibling: Worker + D1 + webhook + per-minute cron, living at $0/mo. The Go monolith sibling ([cokuy-GO](https://github.com/indraprhmbd/cokuy-GO)) is the frozen v0.1 snapshot: single static binary, polling transport, local SQLite. Each sibling keeps the same spirit and the same license: small, boring infrastructure first, persistence before cleverness.

## Contributing

PRs target `main`. One logical change per commit, `tsc` clean plus local-D1 verification notes, architectural changes ship with a note under `docs/decisions/`. Improvement points, migration rules, and the full PR checklist live in [CONTRIBUTING.md](CONTRIBUTING.md).

## License

MIT. Copyright (c) 2026 indraprhmbd. See LICENSE.
