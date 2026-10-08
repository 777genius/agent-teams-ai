# Tooling TypeScript checks

Keep application and Electron entrypoints in the root `tsconfig.json` and
`tsconfig.node.json`. Specialized tooling checks live here; paths inside these
configs are relative to this directory.

- `e2e-base.json` shares the strict React/Node options used by desktop E2E,
  Sentry UI E2E, and the focused message-history gate.
- `tsconfig.desktop-e2e.json` groups external-agent connection, shared-root,
  team-prompt management, and OpenCode recovery scenarios in one compiler run.
- `tsconfig.sentry-e2e.json` groups tab-identity and inbox-provenance scenarios
  with the additional erasable-syntax restriction.
- SDK envelope main, preload, and renderer checks stay separate to preserve
  their process-specific ambient environments.
- Release tooling, updater, packaged CI, and message-history checks retain
  their own compiler options or focused gate.

Add a scenario to a compatible group's `include` list. Create a separate config
when its compiler options, process environment, or focused gate differ. Keep
`pnpm typecheck`, workflow checks, and fixture artifact references in sync.
