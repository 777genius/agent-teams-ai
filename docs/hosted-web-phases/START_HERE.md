# Hosted-web execution: start here

This is the canonical entrypoint for every hosted-web controller and worker. Phase 0 is accepted and
frozen at `f4fa24aac9615a4ce10632965a2244a2e11a273e`. Its accepted supporting authorities are
orchestration `1587615c751c3cb12b5078ab4b7264b6e9fd42ad`, bounded navigation
`f32be6a6fcb2da7a47ef3553476430ef8052e19a`, and estimate reconciliation
`f4fa24aac9615a4ce10632965a2244a2e11a273e`. Each launch still binds its exact worktree HEAD as
`phaseStartSha`; that launch value is not a substitute for the Phase 0 freeze commit.

## Deterministic reading order

Read only this bounded sequence before working:

1. `AGENTS.md`.
2. This file.
3. `docs/hosted-web-phases/EVIDENCE_LIFECYCLE.md`.
4. `docs/hosted-web-phases/README.md`, then `docs/hosted-web-phases/EXECUTION_INDEX.json`.
5. The current controller packet named by the subscription-runtime `worker-start-v1` contract. The
   compact router currently authorizes only Phase 1 foundations `P1.S1`.
6. The one assigned lane packet, followed only by the exact files in that runtime contract's
   `mandatoryDocs`, `mandatoryScripts`, and `mandatoryFixtures` lists.

Do not recursively explore documentation or evidence directories. In particular,
`docs/research/hosted-web` is preserved evidence, not a reading queue. Read a file beneath it only
when the assigned packet lists that exact repository-relative file path. Directory paths, globs, and
recursive patterns are invalid mandatory reads.

## Start gate

Before launch, the hosting controller must admit the work through subscription-runtime's builtin
`worker-start-v1` boundary. The runtime contract must bind the current controller packet, exactly one
lane packet, and the bounded read set above. Runtime admission is not permission to use a real
project. This repository contains no hosted-worker admission or launch implementation.

## Authority and preservation

[`EXECUTION_INDEX.json`](EXECUTION_INDEX.json) classifies execution authority, current-phase inputs,
on-demand references, and preserved history. The parent plan and blocked Phase 1 proposal are not
worker prompts. A lower tier may narrow work but cannot broaden scope or weaken a guardrail.

Existing evidence is immutable input. Do not delete, move, rename, truncate, regenerate, or rewrite
it. Corrections use a new artifact and the lifecycle in
[`EVIDENCE_LIFECYCLE.md`](EVIDENCE_LIFECYCLE.md).

The exact-image/profile, provider-canary, production-composition, and terminal-negative limitations
remain explicit later-phase implementation risks. They do not reopen Phase 0 or authorize repeated
research. `P1.S0` is accepted at `6f1a87daa9a4bfdf5d754347d92f313f28d0f95d` and is an ancestor of
the transition base `f12a85af0fddadd06f69a27ef408d26bc27eb3fc`; its exact six bootstrap evidence
paths remain immutable. Its historical `phaseStartSha` remains
`5f30df49e052d1cc1d0e7efd03aa105673b5b614`. This router transition authorizes exactly `P1.S1`;
`P1.S2` and every later Phase 1 subphase remain blocked.
