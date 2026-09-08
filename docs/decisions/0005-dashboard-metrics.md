# 0005 — monitoring dashboard and metrics endpoint

Status: accepted (2026-09-09)

## Decision

Ship a SvelteKit monitoring dashboard (`dashboard/` subdir, same VPS,
localhost-only via `adapter-node`) backed by a new Go metrics endpoint:

- Migration `002`: `turn_stats` table (one row per turn, success or
  failure: token counts, model, latency_ms, error text). Usage is
  currently log-only; the dashboard needs it persisted and queryable.
- `GET /metrics` on localhost (`internal/metrics`, stdlib `net/http`
  only): totals, per-day tokens/turns, recent errors, conversation list.
  Bearer token from `METRICS_TOKEN`; server does not start when the
  token is empty (off by default, fail closed).
- Dashboard stack: SvelteKit 2 + Svelte 5 runes, Tailwind v4,
  shadcn-svelte (owned code, Bits UI a11y), `mode-watcher` (SSR-safe
  theme, no flash), `@indaco/svelte-iconoir` (subpath imports),
  LayerChart 2 (Svelte-native SVG charts).
- Theme: solid Finder-style palette, no glassmorphism, no emojis,
  no em/en dashes in copy. Tailwind v4 `@custom-variant dark` with
  class strategy driven by `mode-watcher`.
- Pages v1: overview (stat cards, tokens/cost area chart, turns bar
  chart), conversations (table + detail), logs (recent turns + errors).
  Data via `+page.server.ts` load from Go `/metrics`; slow queries
  stream as promises.

## Rationale

Direct SQLite reads from Node would put two processes on one SQLite
file and couple the dashboard to schema internals; a narrow HTTP API
keeps SQLite single-writer and the schema free to evolve. stdlib HTTP
adds zero dependencies to the Go binary. shadcn-svelte over Skeleton:
owned code fits a custom Finder aesthetic better than a theming engine,
and accessibility comes free via Bits UI. LayerChart over ECharts:
Svelte-native, tree-shaken, sufficient for line/bar needs.

## Exit path

- v1 deviation: hand-rolled SVG area/bar charts instead of LayerChart 2.
  Two charts do not justify a chart dependency; adopt LayerChart only
  when a chart need exceeds hand SVG (tooltips, zoom, stacked series).
- Icons vendored (`dashboard/src/lib/icons/*.json`, MIT Iconoir data)
  behind a local `Icon.svelte` renderer. Reason: `@indaco/svelte-iconoir`
  is Svelte 3 era (stale exports map, no types, JSON-data API), which
  broke the Svelte 5 build. Drop the dep entirely rather than fight it.
  Sidebar nav keeps icons; overview StatCards dropped them (decorative
  glyphs added noise, not signal).
- Spend is server-computed, not client-estimated: `/metrics` returns
  `cost_usd` on totals + daily rows plus the `pricing` it assumed, priced
  by `LLM_PRICE_IN_PER_M` / `LLM_PRICE_OUT_PER_M` env (defaults Sumopod
  promo $0.03/$0.12). Pricing changes are an env edit, never a migration;
  historical dollars re-price at the current rate, which is documented in
  the payload so the dashboard labels the assumed rate.

- Public dashboard later: bind control + real auth (not bearer token).
- If metric volume ever matters: aggregate rollups; personal scale
  will not reach this.
