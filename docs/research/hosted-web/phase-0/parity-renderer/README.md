# Phase 0 W1 parity and renderer evidence

This remediation replaces the rejected per-JSX heuristic inventory with reviewed semantic contracts.
Action identity is an explicit, canonical ID such as `team.lifecycle.stop` or
`provider.management.credentials.edit`. A source file, normalized source hash, and occurrence count
are refreshable evidence only; inserting unrelated lines cannot change an action ID.

The checked-in evidence is intentionally compact:

- `api-parity-ledger.json` gives every pinned `TeamsAPI`, `ReviewAPI`, and `CrossTeamAPI` member exactly
  one explicit owner, disposition, security class, semantic evidence obligation, action ID, and work
  package. Renderer caller paths omit source line numbers.
- `renderer-child-control-catalog.json` is the reviewed, omission-sensitive catalog for the complete
  relative/renderer-alias import closure rooted at `TeamListView`, `TeamDetailView`, the globally
  mounted approval sheet and task-detail dialog, and the provider management panel. Its 171 declared
  source files must exactly equal the recursively discovered closure; 666 stable source keys cover
  every non-root child control occurrence. The scanner also proves the `App` and `TabbedLayout` mount
  chains for the two global roots.
- `renderer-action-inventory.json` maps all 817 scanner-visible sites in that closure to 491 semantic
  actions or six deliberate absence classes. Multiple AST sites for keyboard/click parity or a Select
  trigger/item/change widget may map to one action. Interaction discovery covers the complete React
  event families (including capture variants) and every `on*` callback on directly imported external
  components, rather than a selective event-property allowlist. This includes both mounted
  `DndContext.onDragCancel` sites and `Sheet.onClose`/`Sheet.onSnap`. The separately mounted
  approval/task roots include 29 sites in
  `ToolApprovalSheet`, `ToolApprovalDiffPreview`, `ToolApprovalSettingsPanel`, and
  `GlobalTaskDetailDialog`. Pure containment, dialog state, and local presentation handlers are
  explicit non-actions; mixed containment/action handlers map to the semantic effect. All
  seven other production team TSX files are recorded with their 11 interaction sites and excluded only
  because no import path from a mounted W1 root exists.
- `legacy-bypass-inventory.json` retains counts and a hash of the deterministic raw projection. The raw
  rows are generated outside Git at the recorded `/tmp` path so the adoption remains focused.
- `selection-reconciliation-invariants.md` records the already-approved selection/race constraints.
- `estimate-input.json` records the arithmetic as calculated; it does not suppress the two >20% changes.

Run:

```bash
node --import tsx scripts/hosted-web/phase-0/parity-renderer/scan-api-and-actions.ts
pnpm exec vitest run test/architecture/hosted-web/phase-0/parity-renderer/scan-api-and-actions.test.ts
```

The scanner fails closed for missing/extra closure files, broken global mount chains, omitted
immediate-child mappings, missing/duplicate API dispositions, missing/duplicate semantic mappings,
stale source references, legacy-child/API owner conflicts, and unannotated dynamic API dispatch. The
focused fixture mutates the real
`TeamListFilterPopover.tsx` closure and mapping, and also covers omitted onBlur/onPaste/onContextMenu/
onDragStart families, capture variants, a mixed containment/action negative, the real TaskDetailDialog
subject-save paths, and repository-backed removal negatives for `DndContext.onDragCancel`,
`Sheet.onClose`, and `Sheet.onSnap`. It also covers an event-containment handler, provider credential
input, multi-part Select, semantic missing/duplicate mappings, and root/child line-shift ID stability.

The generator follows both relative imports and the team/provider renderer aliases used by production
components. A file outside the closure is not silently ignored: it is emitted in `excludedSourceFiles`
and its exclusion is regenerated from the current import graph. The direct renderer API caller scan is
repository-wide, so all IPC semantics remain tied to the 109-member parity ledger even when a control
delegates through a child callback.
