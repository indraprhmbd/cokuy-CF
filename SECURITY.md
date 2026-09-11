# Security Policy

## Model

Cokuy CF is a single-owner personal agent. There is no multi-tenancy:
every Telegram sender not on the allowlist is silently dropped, and every
turn fail-closes when config is missing.

- **Auth**: `ALLOWED_USER_IDS` allowlist (empty = deny all) + Telegram
  `secret_token` webhook verification (`webhookAuthorized`).
- **Secrets** (`BOT_TOKEN`, `LLM_API_KEY`, `TELEGRAM_WEBHOOK_SECRET`) travel
  only via `wrangler secret put`. Never in env files, logs, or commits.
- **Logs** must never include tokens, message text beyond debug need, or
  embeddings. Structured JSON logs are persisted via Workers Logs — treat
  them as sensitive as the DB.
- **Injection**: user/LLM text is untrusted. FTS5 `MATCH` receives only
  quoted tokens from `ftsMatchQuery`; SQL is parameterized everywhere.

## Reporting

This is a personal project — open a private security advisory on GitHub or
DM the owner. Please don't file public issues for live secrets or bypasses.

## Scope notes

- `wrangler.jsonc` intentionally contains only placeholder `vars`; real IDs
  and endpoint URLs are deploy-time `--var` flags. The D1 `database_id` is
  committed (required by tooling, not a secret).
- The threat model does not cover a compromised owner Telegram account —
  allowlisted senders have full agent access by design.
