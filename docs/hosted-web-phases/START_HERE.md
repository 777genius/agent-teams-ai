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
5. The current controller packet named by the validated worker-start contract. The compact router
   currently authorizes only Phase 1 serial bootstrap `P1.S0`.
6. The one assigned lane packet, followed only by the exact files in that contract's
   `mandatoryDocs`, `mandatoryScripts`, and `mandatoryFixtures` lists.

Do not recursively explore documentation or evidence directories. In particular,
`docs/research/hosted-web` is preserved evidence, not a reading queue. Read a file beneath it only
when the assigned packet lists that exact repository-relative file path. Directory paths, globs, and
recursive patterns are invalid mandatory reads.

## Start gate

Before launch, run the bounded worker-start validator, then validate its single queued registry
record:

```text
node scripts/hosted-web/orchestration/validate-worker-start.mjs --contract <absolute-contract-path>
node scripts/hosted-web/orchestration/validate-worker-admission.mjs --contract <absolute-contract-path> --state <absolute-state-path>
```

The contract must bind the current controller packet, exactly one lane packet, and the bounded read
set above. Validation success is admission evidence; it is not permission to use a real project.

## Authority and preservation

[`EXECUTION_INDEX.json`](EXECUTION_INDEX.json) classifies execution authority, current-phase inputs,
on-demand references, and preserved history. The parent plan and blocked Phase 1 proposal are not
worker prompts. A lower tier may narrow work but cannot broaden scope or weaken a guardrail.

Existing evidence is immutable input. Do not delete, move, rename, truncate, regenerate, or rewrite
it. Corrections use a new artifact and the lifecycle in
[`EVIDENCE_LIFECYCLE.md`](EVIDENCE_LIFECYCLE.md).

The exact-image/profile, provider-canary, production-composition, and terminal-negative limitations
remain explicit later-phase implementation risks. They do not reopen Phase 0 or authorize repeated
research. `P1.S1` and every later Phase 1 subphase remain blocked until the integrated `P1.S0`
bootstrap and a subsequent router transition authorize them.
