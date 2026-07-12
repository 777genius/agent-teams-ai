# Hosted Web execution router

Always begin with [`START_HERE.md`](START_HERE.md). This router selects the executable phase; it does
not redefine product architecture or turn preserved evidence into worker instructions.

## Fixed route

1. Read the baseline in `START_HERE.md`.
2. Confirm the tier and phase status in [`EXECUTION_INDEX.json`](EXECUTION_INDEX.json).
3. Read the current controller packet named by the worker-start contract.
4. Read exactly one assigned lane packet.
5. Read only exact lane references listed in that validated contract.

On conflict, stop with `packet_conflict`. A packet or directive may narrow its authority but may not
broaden scope, change an ADR, weaken a guardrail, or skip an exit gate.

## Current execution

Phase 0 is accepted and frozen at `f4fa24aac9615a4ce10632965a2244a2e11a273e`. Its controller packet
and W1-W6 lanes are preserved history, not executable work.

Phase 1 is current, but authorization is deliberately limited to serial bootstrap `P1.S0`. A
validated worker-start contract must bind the current
[`controller packet`](phase-01/controller-packet.md) and exactly one lane packet: the compact
[`P1.S0 serial-bootstrap packet`](phase-01/lanes/p1-s0-serial-bootstrap.md). Only after those two
packets may the worker read exact contract-listed references. No `P1.S1` or later producer may start
until S0 is integrated and this router is explicitly advanced. This transition authorizes bootstrap
freezing only; it does not authorize product source implementation.

## Evidence boundary

`docs/research/hosted-web` is a preserved evidence corpus. Never recursively read that directory.
A worker may read one of its files only when the assigned packet lists that exact path. Evidence is
retained unchanged under [`EVIDENCE_LIFECYCLE.md`](EVIDENCE_LIFECYCLE.md).

## Start and completion

The controller admits the one S0 worker only after the bounded worker-start validator and the registry
admission gate both succeed for exactly one `queued` record. Completion states are `verified`,
`characterized`, `blocked`, `failed`, or `superseded`; vague states such as `done` are not evidence.
