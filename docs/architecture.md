# Architecture

The package is split by Clean Architecture boundaries. `core` defines ports and
runtime policy. Providers, stores, queues and runners are adapters.

Allowed dependency direction:

```txt
provider-codex -> core
provider-claude -> core
account-diagnostics -> worker-core types only
worker-core -> core
worker-local -> core
worker-codex -> core + provider-codex + worker-core + worker-local + store-local-file
worker-claude -> core + provider-claude + worker-core + worker-local + store-local-file
queue-core -> worker-core types only
queue-bullmq -> queue-core + worker-core
stores -> core
runner-github-action -> core
```

`core` must never import Claude, Codex, BullMQ, GitHub or file-system custody
adapters. Providers are sibling modules, not special cases inside `core`.

`account-diagnostics` is a provider-neutral application module. It owns the
status model, merge policy and cached capacity bridge, while Codex and Claude
diagnostic adapters live under their worker modules. See
`docs/account-diagnostics.md`.

`packages/agent-account-observability` is a separate DDD package for deeper
provider account facts such as Codex app-server rate-limit buckets and Claude
Code statusline quota snapshots. It reports facts only; scheduler policy stays
in `subscription-runtime`. See `docs/agent-account-observability.md`.

See `docs/pluggable-agent-runtime.md` for the proposed Claude, Codex and
multi-agent reviewer/tribunal architecture.

See `docs/claude-worker-pool-rfc.md` for the original design background for the
implemented Claude Code backend worker pool, including prewarm,
capacity-aware slot selection and limit rotation.

See `docs/host-app-integration-strategy.md` for the cross-repository adapter
contract for `qa-rig`, `hib-pr-reviewer`, `quanta-pr-reviewer` and
control-layer apps.

See `docs/project-access-boundaries.md` for the provider-neutral worker access
model used to separate read-only observers, isolated workspace writers,
project-scoped coordinators and explicit full-access escape hatches.

See `docs/runtime-ddd-feature-architecture.md` for the balanced strict DDD,
Clean Architecture and feature-slice rules for complex runtime features such as
project-scoped control and policy-controlled integration rights.
