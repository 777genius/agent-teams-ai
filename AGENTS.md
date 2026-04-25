# Agent Navigation

This file is a navigation layer for architecture and implementation guidance.

Start here:
- Repo overview and commands: [README.md](README.md)
- Working instructions and project conventions: [CLAUDE.md](CLAUDE.md)
- Canonical feature architecture standard: [docs/FEATURE_ARCHITECTURE_STANDARD.md](docs/FEATURE_ARCHITECTURE_STANDARD.md)

For new features:
- Default home for medium and large features: `src/features/<feature-name>/`
- Reference implementation: `src/features/recent-projects`
- Feature-local guidance for work inside `src/features`: [src/features/CLAUDE.md](src/features/CLAUDE.md)

## Review guidelines

- Treat regressions in agent team messaging, task lifecycle, session parsing, code review UI, and provider/runtime detection as high priority.
- Verify new medium and large features follow `docs/FEATURE_ARCHITECTURE_STANDARD.md`, especially cross-process boundaries and public feature entrypoints.
- Check that Electron main, preload, renderer, and shared code keep their responsibilities separate and use the documented path aliases.
- Flag changes that manually concatenate agent block markers instead of using `wrapAgentBlock(text)`.
- Flag changes that can break `isMeta` semantics, chunk generation, teammate message parsing, task/subagent filtering, or structured task references.
- Ensure IPC and main-process handlers validate inputs, fail gracefully, and do not expose unsafe filesystem or process access.
- Confirm user-visible workflows have focused tests or a clear verification path when they touch parsing, persistence, IPC, Git, provider auth, or review flows.
- Prefer `pnpm` commands for verification and avoid recommending `pnpm lint:fix` unless the PR explicitly intends broad formatting changes.

Do not treat this file as a second source of truth.
Keep architecture rules centralized in [docs/FEATURE_ARCHITECTURE_STANDARD.md](docs/FEATURE_ARCHITECTURE_STANDARD.md).
