# Plan84 — original Windows environment typed-lint corrections

**Prospective bounded correction.** Publication parent `2bba31bdae95c2d60df2d78e47d0043e9da255ea`, tree `45d4ca9020380fd8d0e843590844bb4c936e26c6`. Source83 actual publication review is closed. Source authoring remains gated on independent documentary review and actual document publication closure.

## Observed boundary

Original head `cd6258fe557b16793fb28b6391d4601a059c8b53`, run 44033362540 / job 133870300688, step 10 failed in the existing `src/features` typed ESLint command with seven errors and 1512 warnings. This establishes a lint failure; it does not establish a typecheck failure. Raw SHA256: `5c43275ab620e1b6b00afe1385a79609c53eed684d036429c5150fb741dba75e`.

## Exact source scope

Only `src/features/agent-backend/main/infrastructure/matchesWindowsLaunchEnvironment.ts`: Git `80fb692b7e05afec6ddc30a2bc13a0185b071daf`, 18859 B, 371 LF. Rebind its full preimage to the publication parent; any unexpected change requires renewed review.

Apply exactly these seven diagnostic corrections:

1. Lines 47–48: convert local object alias `LimitChange` into a five-line interface with identical fields/types; retain its return/array uses.
2. Line 80, diagnostic 81: remove only `else `, retaining both original kind/provider guards and their assignments as two mutually exclusive `if` statements.
3. Line 113: remove only `!` from `address[2]!`.
4. Line 218: remove only `!` from `entries[index]!`.
5. Line 312: remove only `!` from `keys[0]!`.
6. Line 313: the same removal at this separate occurrence.
7. Line 314: the same removal at this separate occurrence.

Natural target size: 374 LF. Preserve every other byte, including unreported assertions.

## Semantic preservation

Read-only dependency: `packages/legacy-agent-host/src/composition/applyOpenCodeRuntimeSource.ts`, Git `958e53a9d61cb007b25d2614b8587f5956bf3dcc`, 2610 B / 55 LF. Public overloads 6–13 require the retained management/member narrowing; do not collapse them into an unsupported union call. The implementation clones its profile at 19 and returns at 31/54 without changing the caller's `recipe.kind`. Therefore the second branch body cannot execute after a successful management branch. Throw order and the shared environment copy remain unchanged. Interface and removed assertions are runtime-erased.

## Review and qualification

No producer, workflow, dependency, test, rule, timer, guard-predicate or cap-baseline changes; no casts or suppressions. Review the exact patch, strict forward/inverse identity and unchanged leaves before publication. Existing resulting-head typecheck and original typed-lint CI must qualify the change; this draft claims no execution or repaired CI result.
