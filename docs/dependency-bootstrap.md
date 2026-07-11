# Dependency Bootstrap

`subscription-runtime` can inspect and hydrate locked Node and Python worker
workspaces while reusing package-manager caches. This is an execution primitive,
not orchestration policy: a host controller decides when a worker needs
dependencies, while the runtime enforces the requested mode and records the
result.

## Supported Projects

- Node: pnpm, npm, Yarn, or Bun selected by `packageManager` or lockfile.
- Python: `pyproject.toml` plus `uv.lock`, hydrated with `uv sync --locked`.

Each worktree keeps its own mutable environment (`node_modules` or `.venv`).
The runtime only shares immutable/download artifacts through the package
manager's native cache. Never point concurrent workers at one writable
environment.

pnpm provides the strongest Node disk reuse because its content-addressable
store can hardlink or clone package content into each worktree. npm, Yarn, and
Bun reuse downloads but still materialize a larger project-local environment.
Migrating a project from npm to pnpm is a project-owned lockfile decision, not a
runtime rewrite.

Docker image builds should use BuildKit cache mounts or Dagger cache volumes.
Those caches solve build pipelines and do not replace interactive worktree
environments.

## Modes And Confirmation

- `off`: skip inspection.
- `preflight`: detect the ecosystem, package manager, lockfile, environment,
  expected binaries, and dependency fingerprint without installing.
- `install`: run the locked package-manager command. This fails closed unless
  `confirmDependencyBootstrap=true` is supplied by trusted host configuration.

The result is written to `dependency-preflight.json` when a job root is
available. Install failures remain observable and do not silently fall through
to an unlocked command.

## Shared Cache Root

Operators configure one absolute host path:

```bash
export SUBSCRIPTION_RUNTIME_DEPENDENCY_CACHE_ROOT=/mnt/worker-volume/agent-dependency-cache
```

The runtime adds a stable project namespace so unrelated projects do not share
lock or lifecycle state. Workers cannot choose this environment variable.

Place the cache and worktrees on the same filesystem. pnpm and uv can then use
hardlinks, reflinks, or clone-on-write where supported. A cross-filesystem
layout loses that benefit and emits
`dependency_cache_cross_filesystem_linking_disabled`.

## Concurrency And Recovery

Bootstrap uses an atomic directory lock per dependency fingerprint. Identical
dependency inputs hydrate serially and then reuse the warm cache; unrelated
fingerprints remain independent. A stale lock is removed only after its age
threshold is exceeded and its owner PID is no longer alive.

Cache garbage collection is an operator lifecycle action. Do not prune a cache
while workers are bootstrapping, and do not use cache cleanup as a substitute
for terminal worktree cleanup.

Higher-level capacity, task selection, producer/reviewer mix, and autonomous
refill belong in an orchestrator above this package. That layer calls the
project-control broker and dependency bootstrap inputs; it must not reimplement
package-manager execution.
