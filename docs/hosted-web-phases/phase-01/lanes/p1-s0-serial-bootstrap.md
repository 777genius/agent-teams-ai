# P1.S0 serial bootstrap lane

## Authority

- Lane: `P1.S0`
- Contract phase/lane: `phase-01` / `p1-s0`
- Controller: `docs/hosted-web-phases/phase-01/controller-packet.md`
- Worker-start revision: `phase-01-s0-bootstrap-r1`
- Status: the single current Phase 1 lane, admitted only through subscription-runtime's builtin
  `worker-start-v1` boundary
- Scope: metadata and evidence serial bootstrap only
- Concurrency: one producer; no refill or successor provisioning

This packet cannot broaden the accepted Phase 0 freeze. It cannot authorize product implementation or
advance the router. Completion returns evidence to the controller; `P1.S1` and all later subphases stay
blocked until a separate reviewed integration and explicit router update.

The worker contract keeps canonical/base provenance at
`42ec333848e29e97c41699b9fed73ed199740e3f` and binds `phaseStartSha` to the isolated
`workspaceRoot` Git HEAD. `jobRoot` is a separate, non-overlapping runtime directory containing the
prompt. Repository reads and check working directories resolve below `workspaceRoot`; `sandboxRoot`
equals or is contained by that workspace and never overlaps `jobRoot`.

## Required outcomes

1. Bind the exact `phaseStartSha` and freeze one Phase 1 packet revision from the accepted Phase 0
   freeze.
2. Resolve proposed downstream identifiers, evidence owners, exact no-glob writer paths, synthetic
   fixture paths, commands, and review pairings into deterministic metadata. Unresolved items remain
   blocked; they are not guessed or silently widened.
3. Record reproducible baseline fingerprints for the checks that later packets will inherit, with
   each failure classified as accepted inherited, newly introduced, or blocking.
4. Reconcile the proposed Phase 1 unique estimate allocation without reopening the accepted Phase 0
   estimate or target-image narrowing.
5. Produce a concise bootstrap report that maps every output to its source reference and states that
   no product source or successor work was started.

## Non-goals

- No file beneath `src/` may be created or changed.
- No contract kernel, route, adapter, feature, fixture implementation, migration, provider runtime,
  artifact composition, terminal behavior, or production registration may be implemented.
- No `P1.S1` or later worker contract, worktree, task, preload, or refill may be created or admitted.
- No accepted Phase 0 decision, evidence artifact, estimate, or preserved history may be rewritten,
  regenerated, moved, or deleted.
- No real user project, credential, raw auth/runtime payload, private host path, or live team may be
  used.

## Exact owned paths

The S0 contract may grant write access only to these new files:

- `docs/research/hosted-web/phase-1/bootstrap/phase-start.json`
- `docs/research/hosted-web/phase-1/bootstrap/packet-revision.json`
- `docs/research/hosted-web/phase-1/bootstrap/ownership-manifest.json`
- `docs/research/hosted-web/phase-1/bootstrap/baseline-fingerprints.json`
- `docs/research/hosted-web/phase-1/bootstrap/estimate-allocation.json`
- `docs/research/hosted-web/phase-1/bootstrap/bootstrap-report.md`

All other repository paths are read-only. The runtime `worker-start-v1` contract must repeat these
paths exactly; directory roots, globs, and implicit sibling authority are invalid.

## Contract-listed references

The worker reads the baseline, controller, and this lane first. Its validated contract may then list
only the exact references required from this bounded set:

- `docs/hosted-web-phases/phase-01/packet-inputs.md`
- `docs/hosted-web-phases/phase-01/architecture-and-contracts.md`
- `docs/hosted-web-phases/phase-01/execution-dag.md`
- `docs/hosted-web-phases/phase-01/conformance-and-tests.md`
- `docs/hosted-web-phases/phase-01/operations-and-risk.md`
- `docs/hosted-web-phases/phase-01/execution-packet-templates.md`
- `docs/research/hosted-web/phase-0/freeze/current-canonical/README.md`
- `docs/research/hosted-web/phase-0/freeze/current-canonical/decision-index.json`
- `docs/research/hosted-web/phase-0/freeze/current-canonical/evidence-index.json`
- `docs/research/hosted-web/phase-0/freeze/current-canonical/lane-identity-index.json`
- `docs/research/hosted-web/phase-0/freeze/current-canonical/review-disposition-index.json`

Absence from the contract means do not read it. No directory, glob, or recursive evidence read is
permitted.

## Required checks

- Confirm subscription-runtime `worker-start-v1` admission before work.
- Run `node docs/research/hosted-web/phase-0/freeze/current-canonical/verify-indexes.mjs`.
- Run `node docs/research/hosted-web/phase-0/estimate-reconciliation/verify-ledger.mjs`.
- Parse every created JSON file and verify deterministic ordering, exact paths, unique IDs, ownership
  disjointness, estimate arithmetic, and baseline fingerprints with contract-listed checks.
- Run targeted lint for every changed script or test, Prettier on the exact changed paths,
  `git diff --check`, an owned-path scope scan, and bounded secret/private-path scans.

Stop with a named blocker on any stale SHA, path overlap, unclassified failure, secret/private-path
finding, accepted-freeze mismatch, or attempt to write product source. Passing these checks does not
authorize `P1.S1`.
