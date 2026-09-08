# DEVELOPMENT

## First principles

Optimize for correctness, inspectability, and low operating cost before raw throughput.

## Development order

1. Telegram -> Go -> LLM -> Telegram
2. Durable conversation persistence
3. Structured memory/state
4. Tasks and open loops
5. Tool calling
6. Multimodal asset persistence
7. Proactive/event-driven behavior
8. Historical/semantic retrieval only where justified

Do not implement later layers merely because the architecture mentions them.

## Coding rules

- Keep the binary simple and dependency-light.
- Prefer standard-library Go where practical.
- Keep I/O boundaries explicit.
- Validate tool arguments and model-produced writes.
- Add migrations for schema changes.
- Test restart/retry/idempotency behavior.
- Log enough to debug failures without logging secrets or sensitive content unnecessarily.
- Benchmark representative workloads, not synthetic vanity metrics.

## Experiments

Every experiment should state:
- question
- hypothesis
- implementation
- metric/observation
- result
- decision or next experiment

An experiment is allowed to fail. A silent assumption is worse than a failed experiment.

## Current open loop

Continuously revisit the initial plan against current best practices, actual measurements, and newly learned constraints. Use relevant skills, MCP/connectors, and current external references when they improve implementation quality. Update this file and `docs/decisions/` instead of letting stale architecture survive by inertia.
