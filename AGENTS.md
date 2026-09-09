# AGENTS.md

## Mission

Build Cokuy as a persistent personal agent, not a generic chatbot.

## Non-negotiables

- Persona: mediocre friend-circle guy; kind, calm, useful, not pretentious.
- Intelligence is allowed to be limited. Never fake certainty or competence.
- Persistence means durable state integrity, not “load the whole chat”.
- Prefer structured deterministic state over semantic retrieval when a fact has a known home.
- History retrieval is a fallback, not the default memory architecture.
- Tasks and open loops are first-class state.
- Multimodal objects live in external object storage; metadata/state belongs in the database.
- LLMs are replaceable runtime components. Core state must outlive model swaps.
- Optimize for cheap, small, boring infrastructure before adding complexity.

## Engineering behavior

- Inspect existing context before changing behavior.
- Prefer the smallest design that preserves correctness.
- Make failures recoverable and state transitions explicit.
- Keep boundaries testable: transport, runtime, storage, tools, inference.
- Avoid speculative abstractions, vector databases, multi-agent systems, dashboards, plugins, or protocol machinery without a concrete use case.
- Experimental/anti-pattern choices are allowed when documented with rationale and an exit path.
- Do not silently change product principles through implementation details.

## Decision hygiene

Classify important changes as: decision, hypothesis, experiment, or open loop.
Record meaningful architectural changes under `docs/decisions/`.

## Context files

Coding-agent context lives under `docs/context/`. Read before changing
behavior: `PRODUCT.md` (what Cokuy is), `PERSISTENCE.md` (state rules),
`ARCHITECTURE.md`, `SOUL.md`, `MEMORY.md`, `DEVELOPMENT.md`,
`SECURITY.md` (archived v0.1 snapshot, principles still apply).

## Living context rule

Always keep the initial plan aligned with current best-practice implementation. Before making consequential technical decisions, use relevant installed skills, MCP/connectors, or current external sources when they materially improve correctness. Update the corresponding context/decision file after learning something that changes the plan.
