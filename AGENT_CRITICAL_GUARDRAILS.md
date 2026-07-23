# Agent Critical Guardrails

These are the hard rules to keep agent work predictable and safe in this repo.

- Read `CLAUDE.md` first, then follow `docs/FEATURE_ARCHITECTURE_STANDARD.md` for new medium and large features.
- Use `pnpm` for project commands. Do not switch to `npm` or `yarn`.
- Use the desktop Electron app (`pnpm dev`) for normal local development and smoke checks unless browser-mode internals are explicitly requested.
- Do not test agent teams, launch/provisioning, terminal runtime, task assignment, smoke-flow, or agent actions on real user projects. Use only new sandbox/test projects or explicitly test-only existing projects. Real projects such as `~/dev/projects/ai/claude-runtime` must not be used even for opening a runtime/terminal without fresh direct user permission.
- Do not run `pnpm lint:fix` unless the user explicitly asks for broad formatting changes.
- Keep cross-feature production imports on public feature entrypoints; keep `core/domain` runtime-free and `core/application` dependent only on domain, contracts, and its own application models, use cases, and ports. Existing violations are exact edges in `scripts/ci/feature-architecture-baseline.json`: do not add exceptions, and run `pnpm guard:feature-architecture`.
- Keep main, preload, renderer, and shared responsibilities separate.
- Build interactive UI controls from reusable Radix UI headless primitives under `src/renderer/components/ui` when a shared primitive exists. Do not add one-off native or hand-rolled controls for selects, dialogs, popovers, tabs, menus, tooltips, switches, or checkboxes.
- Use `wrapAgentBlock(text)` instead of manually concatenating agent block markers.
- Preserve task/subagent filtering, structured task refs, and message parsing semantics.
- Validate IPC and other main-process inputs defensively and fail gracefully.
- Treat `docs/team-management/debugging-agent-teams.md` as the first stop for team launch hangs, bootstrap issues, or missing teammate replies.
- Do not revert unrelated user changes or other agents' edits.
