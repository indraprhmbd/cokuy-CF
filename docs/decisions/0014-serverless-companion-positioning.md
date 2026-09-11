# 0014 - Positioning: serverless companion kit (cokuy-CF is the project)

Status: accepted
Date: 2026-09-10

## Decision

cokuy-CF is the project. Positioning: **serverless companion kit** -
zero-device, zero-cost, persona-first, fork-and-own-your-guy, with
receipts. GO repo stays a frozen archive.

## What we are not

- Worse Jarvis. OpenClaw (388k stars, foundation, 29 channels, full
  system access) and Hermes (Nous, self-improving loop, $5 VPS
  gateway) won power. Unwinnable, not attempted.
- Go-daemon rival. PicoClaw (Sipeed, Go single binary, <10MB RAM,
  16-19 channels, ~30k stars, company-backed) owns
  lightweight-device. Chasing it from the frozen GO repo means
  arriving years late, alone.
- Commercial SaaS. Dies instantly against niche/powerful agents.

## Why the niche holds structurally

- OpenClaw can't shrink to serverless (Node + system access is the product).
- Hermes won't (its learning loop wants a real machine).
- PicoClaw can't run on Workers: Go doesn't compile there, and its
  load-bearing parts (gateway server, long-poll daemon, filesystem,
  subprocess/MCP-stdio, code exec, internal cron) are all forbidden.
  A port would have to become webhook + D1 + triggers - cokuy-shaped,
  minus our head start on budgets, idempotency, and ledger.
- Nobody owns character-first (fixed persona, stated limits) or
  published receipts (cost ledger, kill criteria, decision docs).

## Fragility accepted, priced in

Single-account + free-tier policy risk + quota cliffs + Gateway
lock-in (LLM path runs through CF Gateway; direct-Sumopod base URL
is the documented outage fallback). Mitigations: portable SQL dumps
(add weekly export routine), provider-agnostic wire format, GO VPS
rollback. Nothing beyond that - blast radius is one person's chatbot.
Experimental scope is explicit in the name.

## GO repo future

Frozen archive unless someone needs offline / LAN-only /
no-Cloudflare operation. No unfreezing to chase PicoClaw.

## Roadmap this creates

Former nice-to-haves, now launch requirements: one-command setup,
voice config file, 5-minute continuity demo (seeded memories +
1-minute reminder test), README selling those minutes.
