# ARCHITECTURE

## Goal

A tiny, durable agent runtime around a replaceable LLM.

```text
Telegram
  -> transport/update handling
  -> agent runtime
      -> context resolver
      -> LLM
      -> tools
      -> memory/state writes
  -> Telegram response

SQLite <-> durable state
Object storage <-> images/files/audio/etc.
External LLM <-> inference
```

## Baseline

- Go monolith, single deployable binary.
- SQLite as primary local state store.
- Telegram long polling to remain outbound-only and NAT-friendly.
- Embedded tools instead of separate tool services unless isolation is actually needed.
- External object storage for binary media.
- systemd for process supervision.
- Cheap inference, model replaceability.

## State domains

At minimum distinguish:

`users, conversations, messages, memories, projects, tasks, open_loops, assets, tool_runs, events, telegram_updates`

Do not collapse all of these into a generic “memory” table merely for convenience.

## Agent loop

```text
receive update
-> deduplicate
-> load minimal state
-> build context
-> call model
-> execute bounded tools when requested
-> validate writes
-> persist durable changes
-> send response
-> mark update processed
```

Agent execution should have explicit bounds: max steps, max tool calls, context budget, and wall-clock timeout.

## Context strategy

Use hybrid resolution:

1. application loads deterministic context that is cheap and always relevant
2. model can request specific context through tools
3. semantic retrieval is available only for ambiguous historical recall

## Reliability

The system should survive:
- process restarts
- duplicate Telegram updates
- Telegram outages
- LLM timeouts/errors
- tool failures
- partially completed agent turns
- malformed model output

Design state transitions so retries do not duplicate durable side effects.

## Resource philosophy

Measure memory and CPU before imposing aggressive limits. Avoid architecture that requires resident histories, heavyweight runtimes, or multiple always-on services.

A small VPS is a constraint, not a reason to make correctness fragile.

## Not currently in scope

Vector DB by default, multi-agent orchestration, web dashboard, SaaS multi-tenancy, plugin marketplace, complex external MCP infrastructure, autonomous social behavior.
