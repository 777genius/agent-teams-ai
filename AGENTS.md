# AGENTS.md

## Architecture

- Keep Clean Architecture boundaries: core/domain code owns contracts and ports; transport, files, queues, CLI, MCP and provider details stay in adapters.
- For complex runtime features, follow balanced strict DDD with feature-sliced bounded contexts. See `docs/runtime-ddd-feature-architecture.md`.
- Prefer small focused modules over mixed orchestration files.
- Do not put orchestrator policy into runtime adapters. Runtime reports facts, normalized events and safety decisions; orchestrators decide what to do.
- Keep Temporal, JetStream, Redis, webhooks and file-system details out of `worker-core`; add them only through adapter packages/layers.
- Prefer shared runtime read models over duplicated status parsing in CLI, MCP, dashboard, daemons or orchestrators.

## Type Safety

- Use strict TypeScript enums for provider/runtime/event discriminators instead of free-form strings.
- Do not model extensibility as `string` fallbacks like `"codex" | "claude" | string`.
- When a new provider, runtime status or event type is needed, add it explicitly to the enum and handle unknown legacy input through an explicit `Unknown` enum value or validation error.
- Keep JSON payloads sanitized. Never persist or print secrets, auth payloads, API keys, tokens, cookies or raw provider credentials.

## Git

- Use conventional commit messages.
- Do not use branch names with `codex/` prefix.
