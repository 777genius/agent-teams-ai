# Stage 1 ↔ main integration gate (7 November 2026)

Status: **IN PROGRESS**; evidence is historical until re-executed on this exact merged tree.
This is a qualification of Stage 1 V1 against current product main, not Stage 2 or OpenCode V2 activation.

## Ordered dependencies

1. Isolated Host Stage 1: [Draft #982](https://github.com/777genius/agent-teams-ai/pull/982).
2. Stage 2 readiness documentation: [Draft #1105](https://github.com/777genius/agent-teams-ai/pull/1105), **not merged into this lane**.
3. Separate V2 path: [Draft #1106](https://github.com/777genius/agent-teams-ai/pull/1106) → [Draft #1110](https://github.com/777genius/agent-teams-ai/pull/1110), requiring provider [#1](https://github.com/agent-teams-ai/old-provider-implementations/pull/1) → [#2](https://github.com/agent-teams-ai/old-provider-implementations/pull/2); no V2 activation.

## Reconciliation rules

- Preserve Stage1 Team/Task/Message owner and V1 provider/existing UI paths.
- Preserve recent main changes to schedules, provider readiness, managed Git, and TanStack task view.
- Port fixes to extracted owners rather than reintroducing duplicate legacy writer/source files.
- Require fresh exact-merged-tree typecheck, tests, `pnpm lint`, `pnpm lint:mcp`, full-scope CI/CodeQL and selected native/packed Windows/macOS E2E.
- Reconcile source branch and re-run gates if main advances; never infer PASS from older SHAs.
- All unknown delivery/process custody remains UNKNOWN; no native mutation replay, shared-process stop or credential access.

This integration slice targets **Stage 1 Draft #982 only**. Merging #982 into `main`, releasing Stage 1, or activating Stage 1 V1 as the default requires a **separate owner decision and qualification**; none is authorized here. Stage 2 core switching and OpenCode V2 default activation are also outside this slice.
