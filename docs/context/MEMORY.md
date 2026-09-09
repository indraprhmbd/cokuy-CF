# MEMORY

Memory is durable state, not a transcript dump.

## Memory layers

### 1. Structured state

Facts with an obvious home:
- preferences
- identity/context explicitly worth retaining
- projects
- project status
- tasks
- deadlines
- decisions
- open loops
- relevant relationships between entities

Store these deterministically in SQLite with stable identifiers and explicit schemas.

### 2. Recent/session context

Keep enough recent conversation to preserve local coherence. Bound its size. Summarize or compact when useful.

### 3. Historical conversation

Use retrieval only when the information has no obvious structured home or exact recall is genuinely needed. Semantic search is a fallback, not the default.

## Memory principles

- Distinct information must not be accidentally merged.
- Durable records need stable IDs and provenance.
- Prefer update-over-duplicate when identity is clear.
- Never let an LLM invent arbitrary schema keys without validation.
- Important state changes should be atomic and recoverable.
- Deletion/forgetting must be explicit and auditable.
- A model hallucinating a memory must never create false durable state.

## Suggested shape

`subject + namespace + key -> typed value`

Example:

`user:default | preference.editor -> vscode`
`project:cokuy | status -> experimental`
`task:123 | state -> in_progress`
`loop:42 | state -> unresolved`

Schema is application-owned. The model proposes values; the application validates and persists them.

## Retrieval rule

**Do not retrieve what the system already knows where to find.**

Preferred order:
1. active structured state
2. open loops/current projects
3. recent conversation
4. historical semantic retrieval
