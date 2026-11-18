# Provider status / Create Team UI polish — scoped plan (2026-11-08)

## Goals

1. Dashboard: show a small animated, accessible status indicator **only while OpenCode is really being checked**. A stale/unverified OpenCode count must remain labelled unknown after the check settles; never claim a connection or start provider IPC from the header.
2. Create Team's embedded model picker: show **Manage providers** before Anthropic, opening Settings → Providers without disrupting the draft. Explain connection-gated catalog models and keep the explicit opt-in to show them.
3. Replace the lazy Create Team page's plain loading spinner with a realistic, accessible, noninteractive skeleton matching name, template, members, launch/project and optional sections. Keep Suspense boundaries and project state.
4. Remove only the redundant orange effort warning, keeping the model-specific explanation and capability validation.
5. Constrain Create Team name and template input width responsively (still usable on narrow screens). Improve contrast of shared text inputs/select triggers/textareas using theme-derived translucent overlay (not hardcoded dark colors), without changing disabled/invalid styling.
6. Add meaningful fixture evidence for **connected-only OpenCode summary**: correctly simulate --filter connected (and pagination/partial/failed cases). Do not pretend synthetic credentials are live accounts.

## Architecture / safety

- React components only display existing store or cached evidence. No new dashboard IPC.
- Use shared UI primitives, app theme tokens, existing navigation actions, and existing Create Team layout. No new stores, services, feature flags or global async polling.
- Preserve existing Create Team draft state and all provider model launch authority; manage-providers navigation must not auto-connect.
- Skeleton must be aria-busy, inert and responsive. No brittle fixed pixel positioning.
- Keep real connection/provider-credential tests separate from fixture-based UI proof.

## Review gates

1. Unit: pending vs unknown and settled OpenCode; selected model warning; responsive form classes, loading skeleton and navigation interaction; simulated connected-filter output validity.
2. CI/TypeScript/lint, automated reviewer comments fixed and rereviewed.
3. Electron native Windows/Linux screenshots and Create Team source/packaged flows if available. Compare screenshot dimensions and ensure skeleton/form layout works at different widths.
4. Merge only after exact HEAD E2E/required checks succeed; verify post-merge main.

## Rough change budget

500–900 lines including tests; avoid broad theme refactor (a separate appearance PR is active).