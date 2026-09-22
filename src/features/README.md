# Features

This directory contains the canonical home for medium and large feature slices.

Before creating or refactoring a feature, read:

- [Feature Architecture Standard](../../docs/FEATURE_ARCHITECTURE_STANDARD.md)
- [Feature-local agent guidance](./CLAUDE.md)

Reference examples:

- [`recent-projects`](./recent-projects/README.md) - full cross-process feature
  with contracts, core, main, preload, renderer, and focused tests
- [`agent-graph`](./agent-graph/README.md) - thin feature with `core/domain` and
  renderer integration only
- `codex-model-catalog` and `team-runtime-lanes` - process-limited features
  that omit renderer or preload layers when they do not own those boundaries

Use `src/features/<feature-name>/` by default when the work introduces:

- a new use case or business policy
- transport wiring
- more than one process boundary
- more than one adapter or provider

Feature-local docs should answer navigation questions:

- which shape the feature uses
- which entrypoints are public
- where new adapters, rules, bridges, or renderer surfaces belong
- what tests protect the behavior
- which local files are the best examples for future changes

Do not duplicate architecture rules in feature folders.
Keep the standard centralized in [../../docs/FEATURE_ARCHITECTURE_STANDARD.md](../../docs/FEATURE_ARCHITECTURE_STANDARD.md).

Rule of thumb:

- `recent-projects` is the full slice example with process-aware outer layers
- `agent-graph` is the thin slice example built around `core/` plus `renderer/`
