# Renderer Features - Legacy Note

This directory contains older renderer-local slices and integrations.

For new medium and large features, use the canonical standard instead:

- [Feature Architecture Standard](../../../docs/FEATURE_ARCHITECTURE_STANDARD.md)
- [Canonical feature root](../../features/README.md)
- [Feature-local guidance](../../features/CLAUDE.md)

Default location for new feature work:

- `src/features/<feature-name>/`

Reference implementation:

- `src/features/recent-projects`

Keep `src/renderer/features/*` for:

- existing legacy slices
- renderer-only thin integrations
- work that does not introduce a new use case, transport boundary, or cross-process architecture
