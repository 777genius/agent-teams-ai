# Preserve the hovered review action through editor updates

Written before implementation on 2026-11-14. This repair follows the
current-base reconciliation plan 12 and does not relax the original E2E.

## Actual failure and source diagnosis

The original d104 Review UI job `132236556666`, run `43527078399`, reaches
Keep on the first of two original hunks and durable History 1/0, then
moves the pointer to the visible `const last = 2;` line. Its original
Reject target read times out with zero visible matches. The screenshot
shows one accepted hunk, one pending hunk and no floating toolbar.

Artifact `14086854801` was downloaded after executor restoration. Its ZIP
SHA256 was independently verified as
`12c1b36be773c0e778f4f688f7b089c2b173b86db6065aa6edfc1f66995f9331`.
The original receipt SHA256 is
`270b90e14cddd553bf1992d360d3146438417c63f3a5cc4b327b125cf320156d`.
The receipt remains INCOMPLETE; it is not rewritten into a success.

Source review finds a deterministic conflicting behavior in
`CodeMirrorDiffView`: a real pointer move resolves the current hunk and
shows the toolbar, but every CodeMirror update queues an animation-frame
callback invoking `updateFloatingToolbar` without `clientX`. That function
sets the active hunk to -1 when no x coordinate is supplied and hides the
toolbar. The accept/reject and navigation frame callbacks use the same
no-coordinate path. A queued editor update can therefore erase a newly
hovered actionable hunk while the user keeps the mouse stationary. This
is a source-backed defect consistent with the artifact; the original UI
rerun is still required to establish the complete repair.

## Narrow production change and regression proof

Before changing production behavior, add a renderer regression using the
real CodeMirror merge state and original component controls. Supply only
the DOM geometry/hit-testing unavailable in the test DOM, and control the
original animation-frame queue. Keep the first hunk through the existing
button, hover the remaining hunk, run the already queued editor frames,
then use Reject once. Assert the exact mixed document, original callbacks
and undo isolation. Demonstrate the old source failure before repair.

Centralize the existing deferred toolbar refresh so it reads the latest
retained pointer, checks it against the same mounted editor/root and
resolves the current hunk from the current CodeMirror state. Use this
refresh for original update/accept/reject/navigation callbacks. Do not
reuse an obsolete chunk index after Keep, fabricate hover, dispatch an
extra action, or show controls for an unchanged line. Missing pointer,
pointer leaving the surface, disabled merge controls, disposed/replaced
view and no remaining hunks continue to hide the toolbar. Test those
negative transitions, especially mouseleave before a queued frame runs.

`CodeMirrorDiffView.tsx` is a frozen oversized legacy file. If needed,
extract one cohesive existing toolbar/hit-test helper to an adjacent
focused module with typed inputs. Its physical line count must not grow;
do not raise the baseline or compress unrelated code. The persisted
review ledger, instant apply, filesystem guards, history, task identity
and renderer control selectors remain unchanged.

## Review and original acceptance

A different agent reviews the failing regression and final source. Run
the affected renderer review suite, canonical TS7 and targeted lint with
the isolated merged dependency graph, then run the unchanged original
Electron Review and cold readback journeys. Keep/Reject/Undo/Redo/history,
reload, mixed real file bytes, unrelated dirty Git state and the later
external-write refusal must all retain their existing assertions.

Do not replace the missing button with keyboard/API dispatch, add hover
retries to the E2E, extend its timeout, or mark cleanup complete without
the original Host/process proof. No real Claude or Codex is required.

## First source-bound checks

The initial invocation did not collect tests because the new worktree had
not yet built task-change-ledger. Its failure is preserved separately;
the original ledger build then passed. The next invocation exposed a test
DOM layout omission: CodeMirror virtualized the last line because the
fixture gave every line the container height. Supplying finite real line
and viewport geometry corrected only that test prerequisite.

On the unchanged production source, the corrected three-case suite then
reproduced the intended failure: after Keep and hovering the next hunk,
the queued original frame changed toolbar display from `flex` to `none`.
The other two negative cases passed. Original log SHA256:
`7934cdc4f07d1f57f2e5c0d681bbd69b7baf5099f49c31de5c198d715f367e88`.

The repair resolves the latest pointer only for the same mounted view and
a hit owned by that component root, using the three existing deferred
callbacks. The component's duplicate nearest-hunk helper was replaced by
the behavior-identical existing `computeChunkIndexAtPos` export. This is
an existing responsibility reuse, not compressed formatting: the component
shrinks from 975 to 956 physical lines. No size baseline changed.

The repaired hover suite and the existing draft/history suite passed 6/6,
zero skipped, in the isolated merged dependency graph. Original log SHA256:
`2cb13ab0ed3c9c719d3a46e244d1ad0bf3a0b165ff9cb402eb4eacf746516c9a`.
Independent source review approved the repair and requested explicit
old-view and foreign-hit negative cases for its two new guards. Actual
Electron Review acceptance is still pending; these checks do not replace it.

Before the next original UI run, extend the existing explicit supplementary
source roster with exactly `CodeMirrorDiffView.tsx`, its existing
`CodeMirrorDiffUtils.ts` dependency and the new hover regression. These
three paths were absent from that roster. Preserve all previous inputs and
the original pre-flow/post-cleanup source equality checks; no dynamic
filesystem discovery or new source-freeze mechanism is introduced.

## Final bounded renderer checks

The old-view case retains a queued callback from the original editor,
mounts a different editor, hovers its remaining hunk, then executes that
old callback. It verifies that the old view's coordinate resolver is not
called and that the current toolbar, state and callbacks remain intact.
The foreign-hit case places an unrelated toolbar under the retained
pointer coordinates and verifies that it cannot supply an actionable
hunk. These cases exercise the new ownership checks without changing the
production E2E or its pointer behavior.

The final five hover cases and the three existing draft/history cases
passed 8/8, zero skipped, in 3.358 seconds with pinned Node 24.21.0 and the
isolated frozen dependency graph. Log SHA256:
`508030c0c80bc6ce56b1db628ec1ad0634e227372d935cb5a02818e6da1d09ad`.
This is a renderer regression result. The original Electron Review and
cold readback receipts remain required and are not inferred from it.
