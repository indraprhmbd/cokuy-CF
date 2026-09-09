# 0009 - Lightweight Hand-Rolled Stack vs Full Cloudflare Agents Platform

Status: research only, no code or infra change proposed yet. Update 2026-09-09: Gateway passthrough adopted (custom provider `sumopod`, gateway `cokuy`); rest of verdict stands.

Date: 2026-09-09

Context: single-user personal Telegram bot (cokuy) on Cloudflare Workers Free with hard $0 constraint. Baseline verified in repo: Hono Worker, Telegram webhook with immediate 200 plus `ctx.waitUntil` turn, D1 tables (telegram_updates dedupe, conversations, messages, turn_stats, open_loops, reminders, outbox, profile_facts), plain fetch to OpenAI-compatible third-party gateway (Sumopod, MiniMax-M2.7-highspeed), cron `*/15 * * * *` for proactive ticks, quiet hours 22:00-07:00 WIB, char-budgeted transcript window plus profile-facts block plus persona guard. Deliberately not using Agents SDK, Durable Objects, Workflows, Vectorize, Workers AI, AI Gateway. Owner hypothesis: RAG plus prompt-abstraction engineering may beat the heavyweight approach for this use case. This doc tests that belief against primary sources only.

## 1. What the full Cloudflare Agents platform actually is today

### 1.1 Agents SDK runtime

The Agents SDK provides two APIs: a server-side `Agent` class and client-side `AgentClient`, `useAgent`, `useAgentChat` ([source](https://developers.cloudflare.com/agents/runtime/agents-api/)).

An Agent is a class extending `Agent` and routed via `routeAgentRequest`. Each instance has a globally unique name or ID and runs as an independent micro-server, allowing horizontal scaling to millions of instances ([source](https://developers.cloudflare.com/agents/runtime/agents-api/)). The docs state explicitly that Agents require Durable Objects ([source](https://developers.cloudflare.com/agents/runtime/agents-api/)).

Core per-instance capabilities listed on the Agents API page:

- persisted `state` with `setState` and `onStateChanged`, plus embedded SQLite via `this.sql` ([source](https://developers.cloudflare.com/agents/runtime/agents-api/))
- callable RPC methods via `@callable` decorator ([source](https://developers.cloudflare.com/agents/runtime/agents-api/))
- scheduling via `schedule`, `scheduleEvery`, `getScheduleById`, `listSchedules` ([source](https://developers.cloudflare.com/agents/runtime/execution/schedule-tasks/))
- durable execution via `runFiber`, `startFiber`, `stash`, `onFiberRecovered`, `keepAlive` ([source](https://developers.cloudflare.com/agents/runtime/execution/durable-execution/))
- queue via `queue` and `dequeue` ([source](https://developers.cloudflare.com/agents/runtime/agents-api/))
- WebSockets with `onConnect`, `onMessage`, `onClose`, `broadcast` ([source](https://developers.cloudflare.com/agents/runtime/agents-api/))
- HTTP and SSE via `onRequest` ([source](https://developers.cloudflare.com/agents/runtime/agents-api/))
- email routing via `onEmail` ([source](https://developers.cloudflare.com/agents/runtime/agents-api/))
- Workflows via `runWorkflow` and `waitForApproval` ([source](https://developers.cloudflare.com/agents/runtime/agents-api/))
- MCP client via `addMcpServer` and related methods ([source](https://developers.cloudflare.com/agents/runtime/agents-api/))
- sub-agents, agents-as-tools, agent skills, sessions with compaction and search, Think harness, Chat SDK ([source](https://developers.cloudflare.com/agents/runtime/agents-api/))

What this gives that plain Workers plus D1 plus cron cannot do natively: per-user durable identity with co-located compute plus SQLite, real-time state sync to browsers, resumable streaming, and framework-managed recovery. Plain Workers are stateless isolates with 128 MB memory and no built-in per-entity singleton ([source](https://developers.cloudflare.com/workers/platform/limits/)).

Communication channels are separate from the runtime: chat, voice, email, Slack, webhooks ([source](https://developers.cloudflare.com/agents/)). Tools include browser automation, sandboxed code execution, AI Search, MCP tools, payments, and Code Mode where models orchestrate tools by writing code ([source](https://developers.cloudflare.com/agents/)).

For chat specifically, `AIChatAgent` provides built-in message persistence, automatic resumable streaming, and the `useAgentChat` React hook ([source](https://developers.cloudflare.com/agents/runtime/agents-api/)). The chat-agent tutorial builds three tool types in one file: server-side auto tools, client-side browser tools, and approval-gated tools with `needsApproval` plus Approve/Reject UI ([source](https://developers.cloudflare.com/agents/examples/chat-agent/)). Our stack has none of this: single Telegram transport, no streaming resume, no approval pause.

### 1.2 Durable Objects role

Durable Objects combine compute with strongly consistent co-located storage, provisioned near first request, shut down when idle, addressable by globally unique name ([source](https://developers.cloudflare.com/durable-objects/)).

Key properties relevant to the gap:

- SQLite storage backend is GA and is the only backend available on Workers Free; key-value backend is legacy and Paid-only for existing namespaces ([source](https://developers.cloudflare.com/durable-objects/platform/pricing/))
- each object is inherently single-threaded with a soft limit near 1,000 requests per second per object, scaling horizontally by creating more objects ([source](https://developers.cloudflare.com/durable-objects/platform/limits/))
- in-memory state plus WebSocket Hibernation API for many idle connections ([source](https://developers.cloudflare.com/durable-objects/))
- alarms for future wakeups with at-least-once execution and up to 6 retries with exponential backoff from 2 seconds ([source](https://developers.cloudflare.com/durable-objects/api/alarms/))
- one alarm slot per object at a time, with a documented pattern to multiplex many scheduled or recurring events through storage plus rescheduling ([source](https://developers.cloudflare.com/durable-objects/api/alarms/))

What this gives that D1 alone cannot: single-writer serialization per entity without external locking, in-memory coordination across clients, sub-minute wakeups without cron, and no cross-region read replica lag for hot entity state. D1 is itself backed by a Durable Object per database and processes queries one at a time per database, queuing then returning overloaded errors under excess concurrency ([source](https://developers.cloudflare.com/d1/platform/limits/)).

### 1.3 Workflows

Workflows build durable multi-step applications with automatic retries, persisted state for minutes to weeks, pause for external events or approvals, and built-in observability ([source](https://developers.cloudflare.com/workflows/)).

Primitives include `step.do` for durable steps, `step.sleep` and `step.sleepUntil` for delays up to 365 days, and `step.waitForEvent` for webhooks or human approval ([source](https://developers.cloudflare.com/workflows/reference/limits/)). Each step has unlimited wall clock time but is subject to CPU time limits ([source](https://developers.cloudflare.com/workflows/reference/limits/)). Waiting instances in sleep, retry wait, or event wait do not count toward concurrency limits ([source](https://developers.cloudflare.com/workflows/reference/limits/)).

What this gives that cron plus outbox cannot: exactly the multi-step durability our outbox reimplements by hand. Our `waitUntil` extension is capped at 30 seconds after response or disconnect ([source](https://developers.cloudflare.com/workers/runtime-apis/context/)), and cron wall time is capped at 15 minutes ([source](https://developers.cloudflare.com/workers/platform/limits/)). Workflows survive those caps by persisting step results and resuming.

### 1.4 Vectorize

Vectorize is a globally distributed vector database for embeddings from Workers AI or bring-your-own providers such as OpenAI, with results that can reference R2, KV, or D1 objects ([source](https://developers.cloudflare.com/vectorize/)).

Technical envelope: max 1536 dimensions float32, 64 byte vector IDs, 10 KiB metadata per vector, topK 50 with values or metadata and 100 without, upsert batches 1000 via Workers or 5000 via HTTP API, 10 metadata indexes per index, 64 bytes indexed data per metadata index per vector ([source](https://developers.cloudflare.com/vectorize/platform/limits/)).

What this gives that D1 LIKE cannot: approximate nearest neighbor search plus metadata filtering without full table scans. D1 LIKE and GLOB patterns are capped at 50 bytes ([source](https://developers.cloudflare.com/d1/platform/limits/)), and rows read counts rows scanned not rows returned, so unindexed filters burn quota ([source](https://developers.cloudflare.com/d1/platform/pricing/)).

Plan gating verdict: confirmed Paid-gated in practice. The Workers pricing page states Vectorize is currently only available on the Workers Paid plan ([source](https://developers.cloudflare.com/workers/platform/pricing/)). The same pricing page still lists nominal Free allotments (30M queried dims per month, 5M stored dims) and the Vectorize limits page lists Free caps (100 indexes, 1000 namespaces) ([source](https://developers.cloudflare.com/workers/platform/pricing/)) ([source](https://developers.cloudflare.com/vectorize/platform/limits/)). The billing rule controls: do not plan Vectorize on $0. Owner belief on gating is correct for new projects.

### 1.5 Workers AI

Workers AI runs 50 plus open-source models on serverless GPUs, callable from Workers, Pages, or API, with AI Gateway, Vectorize, and Workers as companion platform pieces ([source](https://developers.cloudflare.com/workers-ai/)).

Billing is in Neurons at $0.011 per 1,000 Neurons with 10,000 Neurons per day free on both Free and Paid; overage requires Paid ([source](https://developers.cloudflare.com/workers-ai/platform/pricing/)). Embedding prices include bge-small at 1841 Neurons per M input tokens, bge-base at 6058, bge-large at 18582, bge-m3 at 1075 ([source](https://developers.cloudflare.com/workers-ai/platform/pricing/)). Some frontier models require Paid or prepaid AI Gateway credits ([source](https://developers.cloudflare.com/workers-ai/platform/pricing/)).

What this gives that third-party Sumopod fetch cannot: no external API key, co-located inference, unified billing, and a free daily embedding allowance sufficient for a personal bot. It does not give model quality parity with large proprietary chat models; Workers AI chat models are smaller open models with per-token Neuron costs listed in the same pricing table ([source](https://developers.cloudflare.com/workers-ai/platform/pricing/)).

### 1.6 AI Gateway

AI Gateway is available on all plans and provides analytics, logging, caching, rate limiting, retries, and fallback in one line of integration ([source](https://developers.cloudflare.com/ai-gateway/)).

Specifics that matter for our turn_stats replacement:

- caching serves identical requests from cache for lower latency and cost, but currently applies only to identical requests on text and image responses, not semantic similarity ([source](https://developers.cloudflare.com/ai-gateway/features/caching/))
- cache key by default is SHA-256 over provider plus endpoint plus model plus auth header plus full request body; custom keys via `cf-aig-cache-key` and TTL via `cf-aig-cache-ttl` ([source](https://developers.cloudflare.com/ai-gateway/features/caching/))
- rate limiting supports fixed or sliding windows and returns 429 on excess ([source](https://developers.cloudflare.com/ai-gateway/features/rate-limiting/))
- Unified Billing allows prepaid credits for Workers AI and third-party providers with a 5 percent fee and pass-through provider pricing ([source](https://developers.cloudflare.com/ai-gateway/features/unified-billing/))

What this gives that our turn_stats table cannot: token and cost analytics, edge caching, provider fallback, and centralized rate limits without custom SQL. Our table gives product-specific latency and outcome metrics that Gateway does not replace.

### 1.7 Browser Rendering and realtime and voice

Browser Run billing splits Quick Actions (browser hours only) from Browser Sessions via Puppeteer, Playwright, or CDP (browser hours plus concurrent browsers) ([source](https://developers.cloudflare.com/browser-run/pricing/)). Free includes 10 minutes per day and 3 concurrent browsers; Paid includes 10 hours per month then $0.09 per hour ([source](https://developers.cloudflare.com/browser-run/pricing/)).

Realtime in the Agents world is WebSocket Hibernation on Durable Objects plus the Agents WebSocket and SSE APIs ([source](https://developers.cloudflare.com/durable-objects/)) ([source](https://developers.cloudflare.com/agents/runtime/agents-api/)). Voice is a documented channel with a dedicated voice-agent example using speech-to-text and text-to-speech ([source](https://developers.cloudflare.com/agents/)).

Relevance to cokuy: near zero today. Telegram long polling or webhook plus text replies needs no browser and no voice. Browser and voice are correctly out of scope at $0.

## 2. Gap analysis of our lightweight stack

### 2.1 Statefulness and concurrency: D1 vs Durable Object single-writer

Our guard is claim-before-send via D1 INSERT OR IGNORE on update_id, with concurrent `waitUntil` turns possible. This is sound for dedupe but weak for serialization.

D1 facts from primary sources:

- each D1 database is single-threaded and backed by a single Durable Object; replicas are separate objects with per-instance limits applying independently ([source](https://developers.cloudflare.com/d1/platform/limits/))
- throughput is query-duration bound; slow writes queue then overload ([source](https://developers.cloudflare.com/d1/platform/limits/))
- rows read counts scanned rows, so indexes are mandatory; our existing indexes on messages, loops, reminders, and outbox are the right call ([source](https://developers.cloudflare.com/d1/platform/pricing/))
- only 6 simultaneous D1 connections per Worker invocation ([source](https://developers.cloudflare.com/d1/platform/limits/))
- Free queries per invocation: 50 on Free versus 1000 on Paid ([source](https://developers.cloudflare.com/d1/platform/limits/))

Durable Object contrast:

- one object equals one single-threaded coordinator with in-memory state shared across requests to that object ([source](https://developers.cloudflare.com/durable-objects/platform/limits/))
- per-object soft limit near 1,000 requests per second, unlimited objects per namespace ([source](https://developers.cloudflare.com/durable-objects/platform/limits/))
- Agents build on this by giving each user or channel its own instance with embedded SQLite via `this.sql`, avoiding a centralized session store ([source](https://developers.cloudflare.com/agents/runtime/agents-api/))

Gap for cokuy: small but real. Single user plus small allowlist means cross-user races are rare and D1 claim rows plus chat-scoped keys are sufficient. The gap grows if we add rapid-fire group turns, cross-message tool transactions, or per-user in-memory streaming buffers. A single per-chat Agent or DO would give strict ordering and atomic read-modify-write without retry loops. Today this is narrowed by allowlist plus claim ordering, not closed.

### 2.2 Durability of multi-step runs: cron plus outbox vs Workflows and fibers

Our durability is manual: outbox rows, reminder rows, tick every 15 min, quiet-hours and cap gates, claim release on send failure.

Platform contrast:

- `waitUntil` extends HTTP Worker execution only up to 30 seconds after response or disconnect, shared across all calls in the request; unsettled promises are cancelled with a logged warning ([source](https://developers.cloudflare.com/workers/runtime-apis/context/))
- cron and queue consumers and DO alarms each cap at 15 minutes wall time ([source](https://developers.cloudflare.com/workers/platform/limits/))
- Workflows persist per-step results, retry with backoff, sleep up to 1 year, wait for events, and keep only running instances against concurrency caps ([source](https://developers.cloudflare.com/workflows/reference/limits/))
- Agents fibers persist recovery metadata in SQLite, hold a 30 second alarm heartbeat via `keepAlive`, checkpoint with `stash`, and resume via `onFiberRecovered` after eviction from inactivity (about 70 to 140 seconds), code updates, or alarm timeout ([source](https://developers.cloudflare.com/agents/runtime/execution/durable-execution/))

Gap for cokuy: narrow today, structural tomorrow. A Telegram turn that calls Sumopod with 20 second timeout plus 2 retries fits in `waitUntil` 30 seconds only if the happy path holds; tail latency plus detector pass plus sends can exceed it. Our outbox plus 15 min tick recovers at coarse granularity, which is acceptable for reminders and nudges but not for interactive multi-tool chains or human approval pauses. Those genuinely require Workflows (`waitForEvent`) or fibers (`stash` plus recovery). No prompt trick removes a wall clock cap.

### 2.3 Retrieval and RAG: D1 LIKE vs Vectorize

Our memory today is profile facts injected whole (about 50 tokens) plus char-budgeted transcript window, with planned M2 semantic memory and M3 rolling summaries. This matches the product principle that structured state with a known home beats semantic retrieval.

D1 text search limits:

- LIKE and GLOB patterns capped at 50 bytes ([source](https://developers.cloudflare.com/d1/platform/limits/))
- max 100 columns per table, 2 MB per row or BLOB, 100 KB per SQL statement, 100 bound params, 30 second max query duration ([source](https://developers.cloudflare.com/d1/platform/limits/))
- full scans bill rows read on every scanned row ([source](https://developers.cloudflare.com/d1/platform/pricing/))

Vectorize contrast: ANN search with 1536 dim float32 vectors, 10 KiB metadata each, topK 50 with payload or 100 IDs only, batch upserts, and metadata indexes for filtered search ([source](https://developers.cloudflare.com/vectorize/platform/limits/)).

Gap for cokuy: no gap at current scale, real gap at corpus scale. Hundreds of facts with exact keys need no vectors; cosine in-worker is microseconds as noted in 0008. The gap appears past thousands of unbounded memory rows, multilingual paraphrase queries, or cross-chat semantic joins. Vectorize would then win on recall and rows-read cost, but it is Paid-gated per pricing page ([source](https://developers.cloudflare.com/workers/platform/pricing/)), so it is not a $0 option regardless of merit.

### 2.4 Scheduling granularity: cron 1-min vs sleep and hibernate

Our tick is `*/15 * * * *` with UTC scheduledTime converted to WIB, plus quiet hours and daily cap. Cron facts:

- cron expressions use 5 fields with Quartz-like extensions, run on UTC, minimum every minute via `* * * * *` ([source](https://developers.cloudflare.com/workers/configuration/cron-triggers/))
- cron changes can take up to 15 minutes to propagate ([source](https://developers.cloudflare.com/workers/configuration/cron-triggers/))
- Free accounts allow 5 cron triggers per account versus 250 on Paid ([source](https://developers.cloudflare.com/workers/platform/limits/))
- cron invocations share the 10 ms Free CPU limit per invocation and 15 minute wall cap ([source](https://developers.cloudflare.com/workers/platform/limits/))

Agents and DO contrast:

- Agent `schedule` supports delay in seconds, Date, cron strings, and `scheduleEvery` down to 1 second intervals with overlap prevention and idempotent setup in `onStart` ([source](https://developers.cloudflare.com/agents/runtime/execution/schedule-tasks/))
- under the hood this uses DO alarms multiplexed through a single alarm slot with SQLite-backed task rows ([source](https://developers.cloudflare.com/agents/runtime/execution/schedule-tasks/))
- raw DO alarms give programmatic per-entity wakeups, unlike non-programmatic cron ([source](https://developers.cloudflare.com/durable-objects/api/alarms/))

Gap for cokuy: functional, not fatal. Exact-time reminders (for example 07:10 WIB briefing, per-reminder due time) currently quantize to 15 min boundaries and drift with tick phase. Per-user snooze, debounce, second-level retries, and cancellable schedules need alarm-style rows plus rescheduling. We can emulate coarse versions in D1 plus tick; we cannot emulate per-second precision or per-reminder cancellation without polling faster, which burns D1 reads and cron slots.

### 2.5 Observability: AI Gateway vs turn_stats

Our turn_stats plus dashboard gives product truth: per-turn latency, model, token use as reported by gateway, detector outcomes, reminder flush counts.

AI Gateway gives platform truth on all plans ([source](https://developers.cloudflare.com/ai-gateway/)): request counts, tokens, cost analytics, request and error logging, exact-match caching, fixed or sliding rate limits with 429 behavior ([source](https://developers.cloudflare.com/ai-gateway/features/caching/)) ([source](https://developers.cloudflare.com/ai-gateway/features/rate-limiting/)), plus retry and fallback routing. Agents add tracing via `wrapAISDK` and diagnostics channels ([source](https://developers.cloudflare.com/agents/runtime/agents-api/)).

Gap: complementary, not overlapping. Gateway cannot answer did the detector reject, did the nudge cap suppress, did the outbox release the claim. turn_stats cannot answer provider-side retry rate, cache hit rate, or cross-model cost without manual joins. The cheapest close is to put Gateway in front of Sumopod fetches where compatible, keep turn_stats, and correlate by request ID.

Caveat: Gateway caching is exact-match only today with future semantic caching noted as planned ([source](https://developers.cloudflare.com/ai-gateway/features/caching/)). Personal chat with growing transcript windows will rarely hit cache unless we deliberately cache stable subcalls such as detector classification or daily briefing fragments with custom keys.

### 2.6 Tool-calling and human-in-loop patterns

Our detector is a strict-schema JSON parse with wholesale reject on violation. This is a hand-rolled single tool with no framework support for retries, partial approval, or resume.

Platform contrast:

- chat-agent tutorial shows `stopWhen: stepCountIs(5)`, message pruning keeping tool calls before last 2 messages, and three execution modes in one agent ([source](https://developers.cloudflare.com/agents/examples/chat-agent/))
- approval tools pause for explicit Approve or Reject via `addToolApprovalResponse` ([source](https://developers.cloudflare.com/agents/examples/chat-agent/))
- Workflows support `waitForApproval` and event-gated continuation ([source](https://developers.cloudflare.com/agents/runtime/agents-api/))
- Agents expose MCP client, sub-agents, agents-as-tools, and skills registries ([source](https://developers.cloudflare.com/agents/runtime/agents-api/))

Gap: medium and growing with tool count. One detector plus one LLM call needs no SDK. Five plus tools with side effects (send, schedule, delete loop, write fact, call browser) need standardized schemas, approval policy, idempotency keys, and resume after disconnect. The SDK does not make the model smarter; it makes side effects safer.

## 3. Can RAG plus prompt-abstraction close each gap without Agents SDK or Vectorize

Verdict per gap: closed, narrowed, or requires platform.

### 3.1 Concurrency and ordering: narrowed, not closed

Proper lightweight engineering: keep INSERT OR IGNORE claim as the linearization point, add per-chat outbox sequence numbers, batch D1 writes, keep tick under 50 subrequests on Free, use indexes to bound rows read. Add deterministic state machines for loops and reminders with explicit pending, sent, acked, expired transitions.

What prompt engineering cannot do: replace single-writer in-memory serialization or cross-request atomicity. Two concurrent turns for the same chat can still interleave LLM calls and produce duplicate or out-of-order sends. Mitigation is claim-before-LLM plus send idempotency via Telegram message dedupe keys, not smarter prompts.

Requires platform when: group chats burst, or tools mutate shared rows mid-turn. Then one DO or Agent per chat is the correct primitive ([source](https://developers.cloudflare.com/agents/runtime/agents-api/)).

### 3.2 Multi-step durability: narrowed for reminders, requires platform for chains

Proper lightweight engineering: tighten outbox with lease timestamps, exponential backoff in tick, dead-letter after N attempts, split slow LLM generation from webhook ack via Queues (10,000 ops per day free, 24 hour retention) ([source](https://developers.cloudflare.com/queues/platform/pricing/)). Queues are the documented escape hatch when work cannot finish in `waitUntil` ([source](https://developers.cloudflare.com/workers/runtime-apis/context/)).

Structured generation helps by making each step small and verifiable: Zod-validated detector output, router that picks reply versus tool versus defer, summarizer that compacts before the next call. This reduces the chance of hitting the 30 second `waitUntil` cliff but does not remove it.

Requires platform when: chains need pause for user approval, sleep for hours mid-chain, or survive eviction mid-stream. That is Workflows `waitForEvent` and `step.sleep` ([source](https://developers.cloudflare.com/workflows/)) or fibers with `stash` and `onFiberRecovered` ([source](https://developers.cloudflare.com/agents/runtime/execution/durable-execution/)).

### 3.3 Retrieval: closed at personal scale, narrowed at medium scale

Proper lightweight $0 RAG without Vectorize or new vendor:

- table `memories(chat_id, text, embedding, created_at)` with embedding as JSON array or BLOB
- embeddings from existing Sumopod OpenAI-compatible `/embeddings` endpoint, or Workers AI bge-small or bge-m3 within 10,000 Neurons per day free ([source](https://developers.cloudflare.com/workers-ai/platform/pricing/))
- chunking 300 to 500 tokens with 10 to 15 percent overlap, store source message IDs for citation
- per-turn single embed of the query, brute-force cosine over same-chat rows only, top 5 plus char budget
- hybrid: exact profile-facts first, keyword LIKE second for short Indonesian phrases, cosine third; cap injected tokens and log hit rate, matching 0008 metrics plan
- rolling summaries at pressure threshold with transcript budget shrinking as summary grows, never summarizing the summary

Limits versus Vectorize: in-worker cosine is CPU bound under 10 ms Free CPU per invocation ([source](https://developers.cloudflare.com/workers/platform/limits/)) and 128 MB isolate memory; D1 full scans bill rows read per scanned row ([source](https://developers.cloudflare.com/d1/platform/pricing/)); LIKE patterns cap at 50 bytes ([source](https://developers.cloudflare.com/d1/platform/limits/)); per-DB cap 500 MB Free and 5 GB per account ([source](https://developers.cloudflare.com/d1/platform/limits/)). Practical ceiling is low thousands of memories per chat before per-turn embed plus scan cost or cold latency forces ANN, metadata indexes, or per-user sharding. That ceiling is far above current hundreds of facts.

Owner belief test: for this use case, correct. RAG plus prompt abstraction beats heavyweight Agents on cost, latency, and debuggability until corpus scale or approval workflows force the platform. Evidence is the Free CPU, D1 scan billing, and Vectorize Paid gate above: vectors add cost without recall benefit at this size.

### 3.4 Scheduling precision: narrowed, not closed

Proper lightweight engineering: store `run_at` UTC plus WIB display time per reminder, tick scans indexed pending rows, sends due items, reschedules repeating items, keeps quiet-hours and cap gates deterministic. Reduce tick to `*/5` or `* * * * *` only if D1 read budget allows; each tick is 6 to 10 queries today, well under 5M reads per day ([source](https://developers.cloudflare.com/d1/platform/pricing/)).

What remains: exact-time delivery still quantizes to tick phase; per-second debounce and cancellable per-message timers do not exist without alarms. Agent `scheduleEvery` with 1 second precision and overlap prevention ([source](https://developers.cloudflare.com/agents/runtime/execution/schedule-tasks/)) genuinely requires DO alarms ([source](https://developers.cloudflare.com/durable-objects/api/alarms/)).

### 3.5 Observability and cost control: closed by combining both

Proper lightweight engineering: keep turn_stats as product ledger, add Gateway for provider ledger. Route Sumopod chat completions through an AI Gateway endpoint where the provider adapter supports it, set fixed or sliding rate limits ([source](https://developers.cloudflare.com/ai-gateway/features/rate-limiting/)), enable caching only for deterministic subcalls with custom keys ([source](https://developers.cloudflare.com/ai-gateway/features/caching/)), and log `cf-aig-cache-status` HIT or MISS alongside turn_stats rows. No SDK needed.

Requires platform when: need distributed traces across tools or client-visible streaming resume. Then Agents tracing and diagnostics channels apply ([source](https://developers.cloudflare.com/agents/runtime/agents-api/)).

### 3.6 Tool safety: narrowed to about 3 tools, requires platform beyond

Proper lightweight engineering: JSON Schema plus Zod validation, allowlisted keys, idempotency keys on sends and schedules, dry-run mode for destructive tools, eval loop over detector precision and recall using stored turns. Routing via a tiny classifier prompt before the main generation keeps the main prompt small.

Requires platform when: tools need human approval pauses, cross-tool transactions, or MCP reuse. The chat-agent approval flow ([source](https://developers.cloudflare.com/agents/examples/chat-agent/)) and Workflow approval ([source](https://developers.cloudflare.com/agents/runtime/agents-api/)) are purpose-built for that.

## 4. Free-tier cost and limits reality check

All quotable numbers below are from official pricing or limits pages. Daily Free limits reset at 00:00 UTC unless noted.

Workers Free: 100,000 requests per day, 10 ms CPU per invocation, 128 MB per isolate, 50 subrequests per invocation, 6 simultaneous outgoing connections, 64 env vars per Worker, 100 Workers per account, 5 cron triggers per account ([source](https://developers.cloudflare.com/workers/platform/limits/)). Duration has no hard HTTP cap while client stays connected, but `waitUntil` extends only 30 seconds after response or disconnect ([source](https://developers.cloudflare.com/workers/platform/limits/)). Cron, queue consumer, and DO alarm invocations cap at 15 minutes wall time ([source](https://developers.cloudflare.com/workers/platform/limits/)).

D1 Free: 5M rows read per day, 100K rows written per day, 5 GB total storage, 500 MB max per database, 10 databases per account, 7 day Time Travel, 50 queries per Worker invocation ([source](https://developers.cloudflare.com/d1/platform/pricing/)) ([source](https://developers.cloudflare.com/d1/platform/limits/)). Row counting is scan-based with index guidance and meta rows_read tracking ([source](https://developers.cloudflare.com/d1/platform/pricing/)). Hard caps include 2 MB row or BLOB, 100 KB SQL statement, 100 bound params, 50 byte LIKE pattern, 30 second query duration ([source](https://developers.cloudflare.com/d1/platform/limits/)). Exceeding daily reads or writes returns errors until reset; exceeding storage blocks inserts and schema changes until cleanup ([source](https://developers.cloudflare.com/d1/platform/pricing/)).

Durable Objects Free: SQLite backend only, 100,000 requests per day, 13,000 GB-s per day duration, 5M rows read and 100K rows written per day for SQLite storage, 5 GB total storage, 10 GB per object on Paid with 5 GB total on Free, max 100 DO classes on Free ([source](https://developers.cloudflare.com/durable-objects/platform/pricing/)) ([source](https://developers.cloudflare.com/durable-objects/platform/limits/)). Duration bills wall clock while active or non-hibernating; hibernation-eligible idle is not billed ([source](https://developers.cloudflare.com/durable-objects/platform/pricing/)). Single object soft limit near 1,000 rps ([source](https://developers.cloudflare.com/durable-objects/platform/limits/)).

Workflows Free: shares Workers 100,000 requests per day, 10 ms CPU per invocation, plus 1 GB storage and 3,000 steps per day; step billing enforcement from 2026-08-10 changelog date ([source](https://developers.cloudflare.com/workflows/reference/pricing/)). Runtime caps: 1,024 steps per Workflow, 100 concurrent running instances, 100 instance creations per second, 3 day retention, 100 MB max persisted state per instance, 1 MiB step result and event payload, sleep up to 365 days ([source](https://developers.cloudflare.com/workflows/reference/limits/)).

Vectorize: pricing page Paid-only statement controls planning ([source](https://developers.cloudflare.com/workers/platform/pricing/)). Nominal numbers still listed: 30M queried dims per month and 5M stored dims on Free versus 50M queried plus 10M stored included on Paid, with $0.01 per M queried and $0.05 per 100M stored overage ([source](https://developers.cloudflare.com/workers/platform/pricing/)). Shape caps: 1536 dims, topK 50 with payload or 100 IDs only, 10 KiB metadata, 10 metadata indexes ([source](https://developers.cloudflare.com/vectorize/platform/limits/)). Recommendation: treat as $5 minimum, not $0.

Workers AI: 10,000 Neurons per day free on both plans, overage only on Paid at $0.011 per 1,000 Neurons ([source](https://developers.cloudflare.com/workers-ai/platform/pricing/)). Embedding sample: bge-small 1841 Neurons per M input tokens, bge-m3 1075 ([source](https://developers.cloudflare.com/workers-ai/platform/pricing/)). Personal-bot math: even 100 memory writes plus 200 query embeds per day at 500 tokens each is under 200K tokens per day, which is under 400 Neurons on bge-small, well inside free. Chat generation on Workers AI is also inside free at small scale but model quality differs from MiniMax highspeed path.

AI Gateway: available on all plans ([source](https://developers.cloudflare.com/ai-gateway/)). No separate Free request cap in the same table structure as Workers; cost control is via rate limits, caching, retries, and optional prepaid Unified Billing with 5 percent fee ([source](https://developers.cloudflare.com/ai-gateway/features/rate-limiting/)) ([source](https://developers.cloudflare.com/ai-gateway/features/caching/)) ([source](https://developers.cloudflare.com/ai-gateway/features/unified-billing/)).

Queues Free: 10,000 operations per day included, 24 hour non-configurable retention ([source](https://developers.cloudflare.com/queues/platform/pricing/)). Three ops per message (write, read, delete) means about 3,300 messages per day free, orders above personal scale.

Browser Run Free: 10 minutes browser time per day, 3 concurrent browsers ([source](https://developers.cloudflare.com/browser-run/pricing/)). Irrelevant to text bot, useful only if link previews or scraping arrive later.

Personal-bot headroom summary: hundreds of Telegram messages plus 96 cron ticks per day consume a few thousand Workers requests, tens of thousands of D1 row reads with indexes, and a few hundred writes. This is under 1 percent of Free D1 read quota and under 10 percent of Workers request quota. The binding constraints are not quotas but time caps: 10 ms CPU, 30 second `waitUntil`, 15 min cron wall, 50 subrequests, 50 byte LIKE.

## 5. Verdict and recommendation for this project

Verdict: stay lightweight now, adopt narrow platform pieces later, never adopt the full Agents SDK for its own sake at this scale.

The concept is not much better simply because it has Agents. Agents buy durable identity, real-time sync, second-level scheduling, step durability, and approval-safe tools ([source](https://developers.cloudflare.com/agents/runtime/agents-api/)). Our bot needs none of those at single-user text scale strongly enough to pay $5 or accept DO plus SDK complexity. RAG plus prompt abstraction wins here because profile facts plus transcript window plus rolling summaries solve memory without vectors, and outbox plus 15 min tick solves reminders without alarms.

Adopt Agents SDK now if any of these become true: concurrent same-chat turns cause duplicate sends despite claim guards, tools exceed 3 side-effecting actions, need Telegram approval buttons that pause mid-chain, or need per-reminder exact-time delivery with cancellation. Until then the SDK is negative leverage: more bindings, more storage billing dimensions, more eviction and hibernation reasoning, for no product gain.

Ordered highest-leverage additions while staying lightweight and $0:

1. Keep Hono plus D1 plus cron baseline. Add AI Gateway in front of LLM calls for analytics, rate limits, and exact-match caching of deterministic subcalls. Gateway is available on all plans ([source](https://developers.cloudflare.com/ai-gateway/)) and caching plus rate limiting are documented per-request features ([source](https://developers.cloudflare.com/ai-gateway/features/caching/)) ([source](https://developers.cloudflare.com/ai-gateway/features/rate-limiting/)).
2. Finish M1 profile facts with strict key allowlist and whole-set injection, then M3 rolling summaries before M2 vectors. This preserves structured state outside lossy summaries and keeps 30 to 40 percent window discipline without new bindings.
3. Build M2 as D1 plus in-worker cosine only, same-chat top 5, char budget, hit-rate logging. Use Sumopod embeddings or Workers AI bge-small or bge-m3 inside 10K Neurons per day ([source](https://developers.cloudflare.com/workers-ai/platform/pricing/)). Do not add Vectorize while Paid-gated ([source](https://developers.cloudflare.com/workers/platform/pricing/)).
4. Harden outbox with lease timestamps, attempt counts, dead-letter, and tick-side backoff. Add Queues as overflow when a turn cannot fit `waitUntil` 30 seconds ([source](https://developers.cloudflare.com/workers/runtime-apis/context/)), inside 10K ops per day free ([source](https://developers.cloudflare.com/queues/platform/pricing/)).
5. Tighten router plus structured output: small classifier, Zod validation, idempotency keys on every send and schedule. This is the prompt-abstraction core that defers SDK need.
6. Add per-reminder `run_at` index and WIB correctness tests; consider `*/5` tick only after measuring rows_read via D1 meta ([source](https://developers.cloudflare.com/d1/platform/pricing/)). Do not chase per-second precision on cron; that path leads to alarms ([source](https://developers.cloudflare.com/durable-objects/api/alarms/)).
7. Later, if ordering or timers force it, add exactly one SQLite-backed Durable Object or single Agent per chat for serialization plus `scheduleEvery` ([source](https://developers.cloudflare.com/agents/runtime/execution/schedule-tasks/)), still Free-eligible as SQLite DO ([source](https://developers.cloudflare.com/durable-objects/platform/pricing/)). Keep D1 as system of record.
8. Later, if multi-step chains need approval or multi-hour pause, add one Workflow with `waitForEvent` and retries ([source](https://developers.cloudflare.com/workflows/)), inside 3,000 steps per day free ([source](https://developers.cloudflare.com/workflows/reference/pricing/)).
9. Never for this bot unless requirements change: Vectorize Paid gate ([source](https://developers.cloudflare.com/workers/platform/pricing/)), Browser Sessions, voice channels, Sandbox code execution, or Paid CPU upgrades.

Exit logic stays as in 0007: plain SQL dumps keep data portable, VPS binary remains rollback, Turso or Paid $5 are last resorts, not next steps.

## Sources

- Agents overview, channels, harnesses, runtime, tools: https://developers.cloudflare.com/agents/
- Agents API, Agent class, Durable Objects requirement, state, SQL, scheduling, fibers, MCP, observability: https://developers.cloudflare.com/agents/runtime/agents-api/
- Schedule tasks, scheduleEvery, overlap prevention, idempotency, keepAlive: https://developers.cloudflare.com/agents/runtime/execution/schedule-tasks/
- Durable execution with fibers, stash, recovery, eviction causes: https://developers.cloudflare.com/agents/runtime/execution/durable-execution/
- Chat agent tutorial, tool types, needsApproval: https://developers.cloudflare.com/agents/examples/chat-agent/
- Agents observability index: https://developers.cloudflare.com/agents/runtime/operations/observability/
- Durable Objects overview, Free availability for SQLite: https://developers.cloudflare.com/durable-objects/
- Durable Objects pricing, Free versus Paid, SQLite versus KV, hibernation billing: https://developers.cloudflare.com/durable-objects/platform/pricing/
- Durable Objects limits, single-threaded soft 1000 rps, storage caps: https://developers.cloudflare.com/durable-objects/platform/limits/
- Durable Objects alarms, single alarm slot, retries, cron comparison: https://developers.cloudflare.com/durable-objects/api/alarms/
- Workflows overview, durable steps, retries, approvals: https://developers.cloudflare.com/workflows/
- Workflows pricing, Free steps and storage, billing start date: https://developers.cloudflare.com/workflows/reference/pricing/
- Workflows limits, steps, concurrency, sleep, payload caps: https://developers.cloudflare.com/workflows/reference/limits/
- Vectorize overview: https://developers.cloudflare.com/vectorize/
- Vectorize limits, dims, topK, metadata: https://developers.cloudflare.com/vectorize/platform/limits/
- Workers AI overview: https://developers.cloudflare.com/workers-ai/
- Workers AI pricing, Neurons, embedding model costs: https://developers.cloudflare.com/workers-ai/platform/pricing/
- AI Gateway overview, all-plans availability: https://developers.cloudflare.com/ai-gateway/
- AI Gateway caching, exact-match only: https://developers.cloudflare.com/ai-gateway/features/caching/
- AI Gateway rate limiting, fixed versus sliding, 429: https://developers.cloudflare.com/ai-gateway/features/rate-limiting/
- AI Gateway Unified Billing, credits, 5 percent fee: https://developers.cloudflare.com/ai-gateway/features/unified-billing/
- Workers pricing, including Vectorize Paid-only statement, D1 quotas, Queues quotas: https://developers.cloudflare.com/workers/platform/pricing/
- Workers limits, CPU, memory, subrequests, crons per account, waitUntil and wall caps: https://developers.cloudflare.com/workers/platform/limits/
- Cron triggers, 5-field syntax, UTC, propagation delay: https://developers.cloudflare.com/workers/configuration/cron-triggers/
- Context waitUntil 30 second limit and Queues guidance: https://developers.cloudflare.com/workers/runtime-apis/context/
- D1 pricing, rows read versus written, index guidance: https://developers.cloudflare.com/d1/platform/pricing/
- D1 limits, per-DB caps, LIKE 50 bytes, single-threaded per DB: https://developers.cloudflare.com/d1/platform/limits/
- Queues pricing, ops counting, retention: https://developers.cloudflare.com/queues/platform/pricing/
- Browser Run pricing, Quick Actions versus Sessions: https://developers.cloudflare.com/browser-run/pricing/
