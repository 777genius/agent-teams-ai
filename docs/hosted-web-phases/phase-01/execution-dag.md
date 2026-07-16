# Phase 1 execution DAG and ownership

Status: current revision is `phase-01-p1-f-freeze-router-r2`; terminal state is `HOLD`.

## Current DAG

Immutable r1 patch `2f7338a1e7b41955d15106f5fb3994b17db6749158bde8134a0a8e23d2081615` was independently
`REJECT`ed for one P1 merge-proof error. This r2 DAG preserves the remaining r1 route and corrects
only that proof.

```text
P1.I independent ACCEPT; P0/P1/P2 = 0/0/0
  -> exact five outputs proven by
     134f64f0c5c7bbbab0552eddf08df1508118f4bb^..134f64f0c5c7bbbab0552eddf08df1508118f4bb
    -> accepted ordered PR #252 merge 20706bd0...
       parents [134f64f0c5c7bbbab0552eddf08df1508118f4bb,
                6bf43f140878f8b79f7ee17349bd21b177df901d]
       20706bd067ce5ccbf13697700411904faa2a00c8^1 = 134f64f0c5c7bbbab0552eddf08df1508118f4bb
       exact five output bytes preserved
       second-parent diff is accumulated current-base history, never exact P1.I proof
      -> clean remote-equal seven-path P1.F router candidate
        -> independent router review
          -> broker integrates + pushes exact seven router paths
            -> root attests exact pushed authority + clean remote equality
              -> exactly one fresh independent P1.F milestone-freeze worker
                 gpt-5.6-sol / xhigh / default; Fast prohibited
                 exact 74 read-only inputs; exact two writable outputs
                -> ancestry + remote + exact P1.I integration-range proof
                -> ordered true-merge/current-base + first-parent equality proof
                -> five-output P1.I byte preservation at integration and canonical merge
                -> exact 14 evidence IDs + exact 14 gate IDs
                -> 60 Phase 1 tests + 3 focused ratchet tests
                -> typecheck 7 inherited / 0 owned / 0 unexpected
                -> full lint + exact-74 Prettier
                -> exact-54 scratch rollback
                -> JSON/hash/link/diff + classified security scans
                -> complete self-review + explicit ACCEPT or REJECT
                  -> HOLD
                    ACCEPT 0/0/0 --------+-------- REJECT with findings
                       |                              |
                       v                              v
                 root mark_reviewed            no integration;
                       |                       bounded same-two remediation
                       v
               broker integrates + pushes exact two P1.F outputs
                       |
                       v
               root attests exact pushed authority + clean remote equality
                       |
                       v
               separate Phase 2 JIT docs router may be commissioned
                       |
                       -X-> no Phase 2 worker or product work is authorized here
```

All work is serial. Root is the sole orchestrator. `controller-v17` remains `HOLD` and
observation-only and creates no DAG edge.

## Exact ownership

The docs-router author owns exactly:

1. `docs/hosted-web-phases/EXECUTION_INDEX.json`
2. `docs/hosted-web-phases/README.md`
3. `docs/hosted-web-phases/START_HERE.md`
4. `docs/hosted-web-phases/phase-01/README.md`
5. `docs/hosted-web-phases/phase-01/controller-packet.md`
6. `docs/hosted-web-phases/phase-01/execution-dag.md`
7. `docs/hosted-web-phases/phase-01/lanes/p1-f-freeze.md`

The P1.F worker owns exactly, in writer order:

1. `.codex-handoff/phase-01-p1-f.json`
2. `docs/research/hosted-web/phase-1/reviews/phase-1-freeze.md`

The exact 74-path Phase 1 manifest, all product/test source, every frozen P1.I output, the historical
P1.I packet, dependencies, configs, lockfiles, registries, and repository index are read-only. There
is no compile-coherence, cleanup, generated-output, P1.I correction, temporary-repository-output, or
third-path exception.

## Transition policy

The P1.F worker is independent of the router author and all P1.I actors. It writes a complete freeze
record and returns explicit `ACCEPT` or `REJECT`. `ACCEPT` requires every declared proof and zero
P0/P1/P2 findings. Only after root mechanical validation and `mark_reviewed` may the broker integrate
and push the two outputs in writer order.

`REJECT` cannot be converted to integration or successor authority. Only a separately admitted
remediation confined to those two outputs and the immutable findings may follow. No product/test
repair, P1.I repeat, broad cleanup, direct retry, or Phase 2 work is a DAG edge.

After accepted P1.F integration, only a separate Phase 2 JIT docs-router lifecycle may begin. Phase 2
workers remain blocked until that later router independently earns its own authority.
