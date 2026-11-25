# 45. Preserve the existing harness types under the canonical compiler

**Selected narrow follow-up; no source applied yet.** Parent: `767602d62c4f10e78d4d325c0ef92a82b8a0f010`, tree `598e4551f120dccc5e5bdaf31a7ccc051ebc2394`. Retain Plans43/44, all incoming direct-I386 work and the complete prior history.

## Observed failure

The original a07 Team Desktop job `133387314680` and packaged Darwin ARM job `133435460696` both failed their existing canonical typecheck on the same two diagnostics:

- `desktop-team-ui-smoke.test.ts(119,65)`: TS2700, rest types may only be created from object types.
- `verify-desktop-v2-live-membership.ts(93,9)`: TS7022, provider has an implicit any type through initializer inference.

These are actual remote failures, not hypothetical cleanups. The original lint output had eight warnings and no errors; those warnings are outside this change. [1][2]

## Two type-only changes

| Existing path | Exact preimage | Selected change |
| --- | --- | --- |
| scripts/legacy-agent-host/desktop-team-ui-smoke.test.ts | `b7fda498b1e50856211616a3c062ca65a148cc26` | Supply `<typeof diagnostic.viewLoads>` to the original empty-view `assert.deepEqual`. |
| scripts/legacy-agent-host/verify-desktop-v2-live-membership.ts | `d725e255682b0c092e7b05970622e732c1124580` | Annotate the existing find result as `NonNullable<typeof templates>[number] | undefined`. |

The lock-exact `@types/node@24.12.4` strict declaration aliases the generic `deepStrictEqual<T>` as `deepEqual`, with return type `asserts actual is T`. Its inferred empty expected array can narrow the mutable event projection to `never[]`; a later external callback does not widen that flow type. Use the projection's existing declared type while retaining the exact equality assertion and all its runtime arguments.

The explicit provider annotation uses the original canonical template union, including undefined. Preserve the existing find callback and following `assert.ok(provider)`; no replacement shape, suppression, cast or any is selected.

## Preservation and validation

Change only those two type expressions. Preserve every runtime argument, assertion, fixture event, callback, timer, source pin, identity, loop, order and cleanup path byte-for-byte. Do not add or remove an action, assertion, deadline, retry, fixture or test. Both paths already belong to the original typecheck, typed-lint and source-freeze scopes, which remain unchanged.

The existing 2689-line test file is outside the production-source size guard. Its physical line count remains unchanged; no extraction, guard baseline change or unrelated formatting is selected. The verifier remains 154 lines.

Publish and read back this prospective plan before inert source editing. Freeze the exact two-path patch and obtain independent source R2, then publish its source child by expected-parent fast-forward. Reconcile incoming work on a ref conflict; never force or discard it. Wait useful already-started original jobs before advancing the primary PR branch.

No local project execution, compiler, test or manual Actions dispatch is selected. The original resulting-source Team and packaged canonical typechecks must confirm the fix, using the pinned TS7.0.2 command `node node_modules/@typescript/native/bin/tsc` and the unchanged projects. The original tests, lint, Desktop and packaged gates remain authoritative. Source review alone does not establish a green compiler or end-to-end result.

Stage1 remains default-off. Genuine Claude/Codex, Ready, main merge, release/default activation and Stage2 remain unselected.

[1] [Original Team Desktop job](https://github.com/777genius/agent-teams-ai/actions/runs/43892535269/job/133387314680).
[2] [Original packaged Darwin ARM job](https://github.com/777genius/agent-teams-ai/actions/runs/43892535007/job/133435460696).

Independent lock-bound diagnosis SHA256: `720b1951acf0473f1c54341f657c838c2ef41af82ba2f30464fde4ac11f6dbc6`. Exact `@types/node` archive SHA512 was checked against the existing lock; no dependency changes are selected.
