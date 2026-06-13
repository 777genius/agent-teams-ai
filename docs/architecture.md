# Architecture

The package is split by Clean Architecture boundaries. `core` defines ports and
runtime policy. Providers, stores, queues and runners are adapters.

Allowed dependency direction:

```txt
provider-codex -> core
provider-claude -> core
worker-core -> core
worker-codex -> core + provider-codex + worker-core + store-local-file
queue-core -> worker-core types only
queue-bullmq -> queue-core + worker-core
stores -> core
runner-github-action -> core
```

`core` must never import Claude, Codex, BullMQ, GitHub or file-system custody
adapters. Providers are sibling modules, not special cases inside `core`.

See `docs/pluggable-agent-runtime.md` for the proposed Claude, Codex and
multi-agent reviewer/tribunal architecture.
