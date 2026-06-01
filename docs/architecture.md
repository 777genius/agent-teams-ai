# Architecture

The package is split by Clean Architecture boundaries. `core` defines ports and
runtime policy. Providers, stores, queues and runners are adapters.

Allowed dependency direction:

```txt
provider-codex -> core
worker-core -> core
worker-codex -> core + provider-codex + worker-core + store-local-file
queue-core -> worker-core types only
queue-bullmq -> queue-core + worker-core
stores -> core
runner-github-action -> core
```

`core` must never import Codex, BullMQ, GitHub or file-system custody adapters.
Future providers such as Claude should be added as sibling modules, not as
special cases inside `core`.
