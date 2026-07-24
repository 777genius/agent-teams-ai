# Phase 0 W2: Provider and Runtime Ingress

- Packet revision: `phase-00-r2`
- Evidence owner: W2
- Depends on: completed 0A base record and baseline classification

## Mission

Describe real execution topologies and every machine callback, credential and environment boundary.

## Read set

Read the Phase 0 packet sections `Ownership rules`, `W2`, shared schemas and stop conditions. From the
master plan read `ADR-14`, `ADR-18`, `Provider and runtime strategy`, `Agent-specific JSON and protocol
boundary`, `Runtime liveness and recovery state model` and `Hosted provider test matrix`.

## Writable paths

- `docs/research/hosted-web/phase-0/provider-runtime/**`
- `scripts/hosted-web/phase-0/provider-runtime/**`
- `test/architecture/hosted-web/phase-0/provider-runtime/**`
- worktree-local `.codex-handoff/phase-00-w2.json`

## Evidence

- `P0.W2.EXECUTION_TOPOLOGY`
- `P0.W2.RUNTIME_INGRESS_INVENTORY`
- `P0.W2.ENVIRONMENT_PROVENANCE`
- `P0.W2.CREDENTIAL_EXPOSURE_MATRIX`
- `P0.W2.RUNTIME_SCANNER`
- `P0.W2.ESTIMATE`

## Acceptance

Separate provider identity from execution backend; map every bootstrap, delivery, task, heartbeat and
permission operation by direction, authority, idempotency and persisted evidence; classify every child
environment key; prove browser and runtime-ingress authority are disjoint; record Claude/Codex/Gemini
compatibility assumptions and OpenCode differences without exposing secret values.

Do not invent a universal provider interface, launch a provider or use an existing user project.

## Handoff

Run scanner fixtures, lint changed TypeScript files and `git diff --check`. Mark topology claims that
remain source-observed rather than target-verified.
