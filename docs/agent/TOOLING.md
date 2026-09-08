# TOOLING

Tools are interfaces to deterministic system capabilities.

Useful categories may include:
- memory/state read/write
- tasks/open loops
- project context
- recent conversation
- historical conversation search
- asset lookup
- schedule/events

Do not expose every database operation as a tool. Tools should represent meaningful agent capabilities.

A tool should declare name, description, schema, and bounded execution behavior.
