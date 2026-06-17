# Document Import Resolution

When CLAUDE.md files reference external content via `@` imports (e.g., `@docs/architecture.md`), resolve and read those imports before proceeding with the user's request.

## Rules

- Before acting on a user prompt, scan loaded CLAUDE.md files for `@path/to/file` references. Read any that may be relevant to the current task.
- Treat `@docs/` references as pointers to the project's `docs/` directory.
- When a CLAUDE.md says "documentation lives in `docs/`" or "see `docs/` for details," read the relevant docs before proceeding.
- Do not skip imports because "the CLAUDE.md summary seems sufficient." The referenced document is the source of truth.
- After reading imports, reconcile conflicts between the import and the CLAUDE.md summary. Flag discrepancies.
