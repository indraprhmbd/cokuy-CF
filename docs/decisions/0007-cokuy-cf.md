# 0007 — Replatform to Cloudflare ($0/mo)

Status: proposed (2026-09-09)

## Decision

Freeze Go/VPS repo at v0.1+proactive (Sprints A–B done; E–F deferred or
ported). Replatform to TypeScript on Cloudflare: bot Worker + D1 + Cron,
dashboard on Workers Static Assets. Target $0/mo on Workers Free.

## Target architecture

```text
Telegram webhook POST /webhook (secret_token validated)
  -> bot Worker (Hono route + grammY webhookCallback)
    -> allowlist -> claim update_id (D1 INSERT OR IGNORE)
    -> immediate 200, heavy work in ctx.waitUntil
    -> sendChatAction typing -> LLM fetch (Sumopod/OpenRouter) -> reply
    -> detector extraction -> loops/reminders rows
    -> mark processed
Cron */15 * * * * -> scheduled handler = Tick port
    (flush reminders, draft nudges, drain outbox, quiet-hours + cap gates)
Cron 0 0 * * * (UTC = 07:00 WIB, no DST ever)
  -> briefing composer, silent when idle
Dashboard (SvelteKit, adapter-cloudflare) -> Workers Static Assets,
  reads D1 directly via binding (no metrics endpoint needed)
```

## Stack (verified current, Sep 2026)

- **Bot lib: grammY.** Typed, maintained, first-class Workers support.
  `webhookCallback(bot, "cloudflare-mod")`, `BOT_INFO` env var skips
  `getMe` cold call, `secretToken` option validates
  `X-Telegram-Bot-Api-Secret-Token` automatically. Local dev via
  `bot.start()` long-polling, prod via webhook — same handlers.
- **Routing: Hono** (or bare fetch handler; Hono wins once `/health`,
  `/webhook`, admin routes exist).
- **DB: D1.** SQLite under the hood — schema ports verbatim (migrations
  001–003). Access via binding + `.bind()` params; `batch()` where
  atomicity matters. Researched limits that shape code:
  - 50 subrequest queries/invocation (Free) — Tick must stay under
    this; current Tick does ~6–10, fine.
  - **Free-tier hard stop enforced 2026-09-01**: past 5M rows read /
    100K writes per day, D1 returns errors until 00:00 UTC. Personal
    bot does hundreds. Still: catch limit errors explicitly, reply
    degraded, never retry-loop against a quota that can't recover
    until midnight.
  - Count rows scanned, not rows returned. Existing indexes
    (`idx_messages_conversation`, `idx_loops_chat_status`,
    `idx_reminders_pending`, `idx_outbox_pending`) already prevent
    full scans — they port as-is. Watch `meta.rows_read` in dev.
  - 500MB DB cap (Free). Transcript grows unbounded — needs a
    compaction/pruning policy (also missing on VPS; CF forces it).
- **LLM: plain fetch** to OpenAI-compatible `/chat/completions`
  (smaller than JS SDK, provider-agnostic preserved).
  `AbortSignal.timeout(20000)`, 2 retries, ExtraHeaders map (OpenRouter
  Referer/Title) — direct port of `provider.go`.
- **Secrets**: `wrangler secret put` for `BOT_TOKEN`, `LLM_API_KEY`,
  `WEBHOOK_SECRET`. Never in `wrangler.jsonc` `vars` (BOT_INFO getMe
  JSON is safe as var, it's public).
- **Dashboard**: swap `adapter-node` → `adapter-cloudflare`, add
  `wrangler.jsonc` with D1 binding + assets dir. Charts read
  `turn_stats` via `platform.env.DB`. Bearer metrics endpoint deleted.

## Behavior ports (logic identical, language changes)

| Go current | CF port | Notes |
|---|---|---|
| `ClaimUpdate` / `MarkUpdateProcessed` | Same SQL in D1 | Dedupe survives; webhook redelivery safe |
| Sequential poll loop | `ctx.waitUntil` per update | Concurrent updates possible → claim-before-send is the ordering guarantee, not the loop |
| Typing ticker | Single `sendChatAction` before waitUntil work | 5s expiry; re-send if LLM slow |
| Detector JSON parse | Same schema, `JSON.parse` + validators | Same caps, same loud rejection |
| Tick 15-min goroutine | Cron trigger `*/15 * * * *` | Cold start ~0ms, no resident cost |
| Quiet hours 22–07 WIB | Same check on `scheduledTime` | Cron fires UTC; convert to WIB |
| Briefing 07:00 | Cron `0 0 * * *` | UTC midnight = WIB 07:00, stable forever |
| Daily cap 3/chat | `COUNT(*) ... sent_at >= <wib-day-start-utc>` | Same query |

## Migration + cutover (rollback trivial)

1. `worker/` scaffold: DONE (cb83a3b, manual files not
   `npm create cloudflare`). Hono + `/health` + fail-closed `/telegram`
   stub, D1 binding, 001–003 as D1 migrations (applied `--local` OK).
   Notes: wrangler 4 needs `@cloudflare/workers-types@^5`;
   `compatibility_date` can't be future; zero-UUID `database_id`
   works for `--local` only.
2. Port schema: `wrangler d1 create`, replace placeholder id, apply
   001–003 `--remote`.
   Import VPS data: `sqlite3 .dump` → `wrangler d1 execute --file`
   (KBs, instant).
3. Port storage funcs → DONE (`worker/src/db.ts`, 1:1). Verified via
   `wrangler dev` + local D1, not miniflare directly.
4. Port agent turn + detector + Tick: DONE (`llm.ts`, `detect.ts`,
   `turn.ts`, `tick.ts`, grammY Bot API client for sends). Briefing
   deferred (parity A–D first, per loose end 4). Deviation: no
   `webhookCallback` — webhook acks immediately and the turn runs in
   `ctx.waitUntil` (webhookCallback awaits handlers and would hold the
   200 through the LLM call).
5. Local test: DONE. `wrangler dev` + POSTed sample updates (allowed
   turn ran the full error path on dummy creds; stranger dropped;
   non-message claimed+closed) + manual cron trigger (due reminder
   flushed to outbox, failed send released the claim, reminder stayed
   unsent). Smoke rows wiped from local D1 after.
6. Cutover: `setWebhook?url=...&secret_token=...`. Rollback:
   `deleteWebhook` + `go run ./cmd/cokuy` — VPS binary untouched until
   CF proven (keep 1–2 weeks).
7. Dashboard retarget + deploy. Delete Go metrics endpoint only after.

## Exit paths

- CF terms turn hostile → VPS binary still exists, SQLite dump
  reimports anywhere. Data never hostage (plain SQL).
- D1 limits ever bite → Workers Paid $5/mo = same as VPS, or Turso
  (libSQL, monthly not daily quotas, works outside CF).
- Workers request timeout ever clips slow LLM turns → move generation
  into Queue consumer (Queues free tier exists); webhook just enqueues.

## Loose ends for next session

1. Dashboard reads D1 directly (recommended) vs keep bearer metrics
   API in bot worker?
2. Keep `dashboard/` in same repo (`cokuy-cf/` monorepo) or separate
   repo for deploys?
3. `workers.dev` subdomain vs custom domain: RESOLVED — ship on
   workers.dev first ($0, zero setup), add custom domain later once
   the bot is trusted. Telegram delivers to workers.dev with no
   functional difference. Custom domain (~$10/yr, only non-$0 item)
   buys portability (repoint DNS on host exit, no setWebhook dance),
   one home for bot + dashboard subdomains, and fewer corporate
   filter false positives. Non-breaking change: point domain at
   Cloudflare, add Worker custom domain/route, setWebhook to new URL,
   delete old route.
4. Port briefing + context layers (E/F) straight into CF build, or
   ship CF parity first (A–D) then add?

## Sources (Sep 2026)

- Context7: Cloudflare Workers docs (D1 bindings, cron triggers,
  scheduled handler), Hono docs (adapters, validators).
- grammY hosting guides (Workers Node.js + Deno, webhookCallback,
  BOT_INFO cold-start skip, secretToken).
- D1 pricing + limits pages; 2026-09-01 free-tier enforcement
  changelog; SvelteKit adapter-cloudflare docs (Workers Static Assets).
