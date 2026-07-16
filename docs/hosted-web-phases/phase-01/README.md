# Hosted Web Phase 1

Current authority is `phase-01-p1-f-freeze-router-r2`; terminal state is `HOLD`.

## Accepted predecessor

P1.I was independently accepted with zero P0/P1/P2 findings and integrated by
`agent-teams-hosted-web-refactor-p1-i-integration-apply-v17-r2` at
`134f64f0c5c7bbbab0552eddf08df1508118f4bb`; the exact integration proof is
`134f64f0c5c7bbbab0552eddf08df1508118f4bb^..134f64f0c5c7bbbab0552eddf08df1508118f4bb`.
The canonical clean remote-equal authority is `20706bd067ce5ccbf13697700411904faa2a00c8`, the accepted
ordered two-parent PR #252 merge. `20706bd067ce5ccbf13697700411904faa2a00c8^1` equals
`134f64f0c5c7bbbab0552eddf08df1508118f4bb`, and the second parent is
`6bf43f140878f8b79f7ee17349bd21b177df901d`. The five output bytes are identical at the integration
commit and canonical merge. The second-parent-to-merge diff is accumulated current-base history,
never the exact P1.I proof.

Immutable r1 patch `2f7338a1e7b41955d15106f5fb3994b17db6749158bde8134a0a8e23d2081615` was independently
`REJECT`ed for that single P1 proof error. The r2 route preserves every other useful r1 requirement.

The historical [`p1-i-integration.md`](lanes/p1-i-integration.md) packet and every frozen P1.I output
are read-only. No P1.I repeat, regeneration, remediation, or reintegration is authorized.

## P1.F milestone freeze

The current packet is [`p1-f-freeze.md`](lanes/p1-f-freeze.md). After this exact seven-path router is
independently accepted, broker-integrated, pushed, and root attests its exact pushed authority and
clean remote equality, root may admit exactly one serial independent P1.F worker.

The worker profile is only `gpt-5.6-sol`, reasoning effort `xhigh`, and
`serviceTier: "default"`; Fast is prohibited. Root remains the sole orchestrator and `controller-v17`
remains `HOLD` and observation-only.

The worker reads exactly the 74 paths in `EXECUTION_INDEX.json.phase1FreezeManifest.paths`, owns only
`.codex-handoff/phase-01-p1-f.json` and
`docs/research/hosted-web/phase-1/reviews/phase-1-freeze.md`, and records only the new evidence IDs
`P1.F.FREEZE` and `P1.F.PHASE_EXIT`. It verifies canonical ancestry/remote equality, the exact P1.I
integration range, ordered true-merge/current-base shape, first-parent equality, all five P1.I hashes,
all 14 Phase 1 evidence IDs, and all 14 gate IDs.

Required reruns are 13/13 files and 60/60 Phase 1 tests, 1/1 and 3/3 focused ratchet tests, native
TypeScript classification 7 inherited/0 owned/0 unexpected, full lint exit zero, and pinned Prettier
over exactly 74 paths. It also reproves exact-54 scratch-only rollback and performs complete
JSON/hash/link/diff/scope and classified secret/provider/private-path/text scans.

The worker self-reviews and returns explicit `ACCEPT` or `REJECT`, always ending `HOLD`. `ACCEPT`
requires P0/P1/P2 `0/0/0`; after root validation and `mark_reviewed`, the broker may integrate and push
exactly the two P1.F outputs. `REJECT` permits no integration and only separately admitted remediation
bounded to those same two paths and immutable findings.

After accepted exact-two integration and pushed-authority attestation, root may commission a separate
Phase 2 JIT docs router. Phase 2 work remains blocked; P1.F cannot author or launch that successor.
See [`execution-dag.md`](execution-dag.md).
