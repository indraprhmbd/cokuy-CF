# OPEN LOOPS

This file is intentionally small and alive.

- ~~Define the exact v0.1 interaction loop.~~ Closed 2026-09-08: long poll -> allowlist -> claim update_id -> bounded turn (1 LLM call, 20-msg window) -> persist -> reply -> mark processed. See `docs/decisions/0003-v01-loop.md`.
- Decide which state is always loaded versus tool-retrieved.
- Define canonical schemas for memory, tasks, projects, open loops, messages, and assets.
- Define write-trust rules: what the model may persist automatically versus what requires confirmation.
- Decide whether internal tools should eventually expose an actual MCP protocol.
- Measure real RAM/CPU behavior before choosing hard resource limits.
- Evaluate cheap model(s) by useful-task accuracy and total cost, not benchmark prestige.
- Design multimodal ingestion and asset lifecycle.
- Define proactive behavior boundaries and event model.
- Test restart, duplicate update, timeout, retry, and partial-write scenarios.

Always update this initial plan with current best-practice implementation. Use relevant skills, MCP/connectors, and current technical sources when they improve a decision. Close or rewrite loops when evidence changes them.
