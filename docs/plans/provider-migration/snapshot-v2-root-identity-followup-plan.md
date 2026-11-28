# Snapshot V2 root identity follow-up plan

Status: source-confirmed follow-up plan before implementation. Review comment `4728354850` on PR #1318 identified a V2 scalar validation gap in published `73c7723c504327c8ba42cf656e7a39912af5e11e`; root independently checked the actual decoder and strict snapshot test boundaries.

## Problem and exact change

The V2 shape pass currently checks a root row's exact keys but not the runtime type of `identity`. The shared regular expression coerces its operand, so a one-element array containing the valid identity string can pass. Recomputing the actual body digest does not make the array a valid string. This value violates the intended string identity contract.

In the existing `validateV2Shape` root loop, require `typeof root.identity === 'string'` after the exact-key check. Keep the existing shared exact lowercase-hex check. This preserves valid V2 strings and avoids changing the historical V1 decoder or its digest recipe. No root identity, copied file, excluded file, snapshot limit or serializer is changed.

Exactly two existing implementation paths:

1. `packages/legacy-agent-host/src/stopped-team-import/snapshot.ts`
2. `packages/legacy-agent-host/tests/stopped-team-import.test.ts`

## Discriminating controls and compatibility

Add one finite case through the actual exported snapshot validator and existing physical resolver/importer fixture. Start with a valid actual exported V2 snapshot, replace one root identity with `[originalIdentity]`, and recompute the real whole-body digest. No copied validator, fabricated valid digest or new future API is used.

The malformed snapshot must be refused by `validateStoppedSnapshot`, `FileStoppedSnapshotResolver.stage` and the actual importer. The destination must remain empty. Against the unchanged decoder, the first real `assert.throws` must fail because the value is accepted; import/setup/compiler failure is not the intended baseline RED.

Retain and rerun the complete stopped-import, stopped-import RPC and publication cohorts. They include valid V2 metadata, copied bytes and original census checks, plus the genuine Node 24 / pristine `617b15d65e3d1e40d94ee3470eb5fc8399836b68` V1 vector and its stage/import/cold replay behavior. A new malformed V2 value must not be used to rewrite or tighten that historical V1 contract.

## Review and publication sequence

Obtain independent source/design review of this exact two-path change and test approach, then publish this plan with the normal hook before applying the test or production change. Run the actual baseline control, retain the meaningful failure, apply the minimal V2-only guard, and execute the complete three-cohort regression with pinned Host Node 24.21.0. Normal Host build and complete strict Host test typing, changed-file formatting/lint where applicable, and the unchanged source-size/architecture guards remain required. Record actual results; source reasoning alone is not an execution result.
