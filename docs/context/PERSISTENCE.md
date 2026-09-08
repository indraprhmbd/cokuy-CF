# PERSISTENCE CONTEXT

Persistence means durable integrity across sessions, restarts, model swaps, and compacted chat history.

The canonical state should live outside the LLM context window.

Prefer structured state for known entities and explicit relationships. Use conversation history as evidence/context, not as the sole database.
