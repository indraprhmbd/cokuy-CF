# SECURITY

Cokuy is a personal agent with tools and durable state. Treat every external input as untrusted, including Telegram messages, media metadata, LLM output, and tool arguments.

## Principles

- Least privilege for the process and tools.
- Do not run as root unless there is a demonstrated operational need.
- Keep secrets outside source control; prefer a protected environment file or secret store.
- Never treat model output as trusted code or trusted state.
- Tool permissions must be explicit and bounded.
- Separate read tools from side-effecting tools.
- Validate paths, URLs, identifiers, and structured writes.
- Make destructive actions confirmable or otherwise strongly constrained.
- Do not store secrets in chat memory.
- Minimize logs containing personal data.
- Encrypt/protect backups and object storage according to their exposure.
- Verify Telegram sender identity before applying account-level state changes.

## Failure posture

A failed model/tool call must fail closed for dangerous side effects and fail recoverably for ordinary work.

## Security open loop

Revisit Telegram authentication, secret handling, object-storage access, tool sandboxing, backup strategy, and dependency vulnerabilities as the implementation becomes concrete. Use current security guidance when making those decisions.
