
## Final controlled source review and existing type-gate correction

The exact candidate over `462845722260dfd91111c37cb66fc54a01a3ecb7`
has independent renderer/read-side/source review. Root verified the unchanged
raw-controller and legacy routes, one Host read owner, actual roster selection,
existing read settlement/cancellation, rich event identity and all retained
controls. The three existing Desktop scripts were adapted to actual visible
rows without adding business turns; the two existing Claude/Codex finite peers
emit one benign stderr line during their original stream turn. Independent R2
`/root/p09_review` accepted all five diffs. Additional R2 by
`/root/migration_scope_audit` required exact Markdown leaves, same-input tool
correlation, scrolling the real raw-view control and a not-ready result for a
temporarily absent row; those corrections are present.

The existing `test/features/agent-backend/tsconfig.json` narrowed include list
omits two ambient declarations already in the root project:
`src/renderer/vite-env.d.ts` and `test/types/better-sqlite3-node.d.ts`.
The required dedicated TypeScript7 command therefore reports missing Vite
assets/globals and the existing Node SQLite alias. R1 prepared exactly two
include entries, and R2 root independently checked both existing declarations
and the root config. Accept only those two additions; no compiler option,
suppression, new ambient declaration or workflow-gate change is included.
The exact dedicated command passes with those original declarations.

On the final prepared source, the six focused Vitest suites pass62/62, with
no skips. Separate native TypeScript7 checks pass for the agent-backend test
config, the five changed renderer components plus four existing UI suites and
their dependencies, all legacy Host scripts, and the Host test config.
The existing source-size and provisioning-architecture guards pass; scoped
lint and diff checks pass. The full workspace typecheck was previously killed
with137 in this environment; neither that attempt nor these scoped checks are
a full workspace PASS. The existing complete CI gate remains required.

This reviewed candidate still uses the installed checked Session SPI:
`normalizeActivity(Event)`, provider pins and producer Thinking fixtures
remain unchanged. Current-source producer-to-renderer Thinking qualification
and the actual Desktop/native gates remain on HOLD until their real results.
No queued, cancelled, skipped or source-reviewed job is counted as PASS.
