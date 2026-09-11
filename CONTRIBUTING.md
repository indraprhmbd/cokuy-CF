# Contributing to Cokuy CF

## Setup

```bash
cd worker && npm install
cp .dev.vars.example .dev.vars   # real values, never committed
npx wrangler d1 migrations apply cokuy-cf --local
npx wrangler dev
```

`wrangler.jsonc` ships with placeholder `vars` — real `ALLOWED_USER_IDS` /
`LLM_BASE_URL` are injected at deploy time via `--var` flags (see README).
Secrets (`BOT_TOKEN`, `LLM_API_KEY`, `TELEGRAM_WEBHOOK_SECRET`) only ever go
through `wrangler secret put`, never env files.

## Ground rules

- **Migrations are append-only.** New file `NNNN_name.sql`, never edit an applied one. Verify locally (`--local`) before `--remote`.
- **Verify before deploy**: `npx tsc --noEmit` + local-D1 exercise of the touched path (recall, memory writes, tick). No test suite yet — your verification notes in the commit/PR description are the test suite (see below).
- **Decisions over diffs.** Anything architectural goes in `docs/decisions/NNNN-topic.md` (context → decision → rationale → tradeoffs → kill criteria). See `docs/decisions/README.md` and `AGENTS.md`.
- **Keep it boring.** Smallest design that preserves correctness. No vector DBs, agents frameworks, or new infra without a measured reason.
- Commits: short imperative subject (`0018 FTS5+RRF hybrid recall`), body with what + verification.

## What to improve (good first work)

Ranked by value/effort. Each should ship with its own decision doc + kill criteria.

1. **0018 kill-criteria automation** — weekly digest comparing recall hit-rate with vs without FTS picks (`turn_stats`, `source` column). Decides whether the FTS branch lives.
2. **Indonesian eval set** — 20–50 fixed Q/A pairs (paraphrase + exact-name) run against local D1; turns "feels better" into a number. Unblocks all future retrieval tuning.
3. **Threshold re-tune** — cosine `0.72`, top-5, 1500-char budget were set by feel. Grid-search against the eval set from (2).
4. **Provider port proof** — replaceability is doctrine but untested. Port one turn to a second OpenAI-compatible provider, document what broke.
5. **Quiet-hours per-user prefs** — currently global WIB + global cap; make it per-chat.
6. **Write-path FTS sync audit** — `memories_fts` is synced by code, not triggers. A periodic reconciler (or a backfill check in tick) would close the drift window.
7. **`/usage` cost dashboard** — ledger exists (`turn_stats`), surface is one command. Weekly spend summary via tick.
8. **Backfill strategy** — lazy JSON→BLOB backfill races sustained load; measure, then decide eager vs trigger.
9. **Test harness** — RRF math, MATCH escaping, allowlist parsing are pure functions begging for unit tests. Start there, not e2e.
10. **Multimodal metadata** — attachments currently out of scope; design photo/file → object-storage + metadata-in-D1 before any code.

## PR checklist

- [ ] `tsc --noEmit` clean
- [ ] Local D1 verification notes (what you ran, what you saw)
- [ ] Migration only additive / N/A
- [ ] Decision doc added or updated / N/A
- [ ] No secrets, IDs, or account hashes in diff (`git diff | grep -iE 'token|key|secret|allow'`)
