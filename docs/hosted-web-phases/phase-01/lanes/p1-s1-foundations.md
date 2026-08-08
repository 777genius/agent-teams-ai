# P1.S1 foundations lane

## Authority

- Lane: `P1.S1`
- Frozen owner: `P1.1A`
- Contract phase/lane: `phase-01` / `p1-s1`
- Controller: `docs/hosted-web-phases/phase-01/controller-packet.md`
- Worker-start revision: `phase-01-s1-foundations-r1`
- Accepted predecessor: P1.S0 commit `6f1a87daa9a4bfdf5d754347d92f313f28d0f95d`
- Transition base: `f12a85af0fddadd06f69a27ef408d26bc27eb3fc`
- Historical S0 `phaseStartSha`: `5f30df49e052d1cc1d0e7efd03aa105673b5b614`
- Status: the single current Phase 1 lane, admitted only through subscription-runtime's builtin
  `worker-start-v1` boundary
- Concurrency: one producer; no refill or successor provisioning

The runtime contract binds `phaseStartSha` to the isolated `workspaceRoot` Git HEAD. That SHA must
contain this router transition, descend from the transition base, and preserve the exact six accepted
S0 evidence paths. It does not replace the historical S0 `phaseStartSha` above.

## Mission

Implement the frozen `P1.1A` minimal shared hosted contract kernel and its focused parser/version
tests. Produce evidence `P1.1A.KERNEL` and `P1.1A.VERSION` without creating a feature DTO, transport
contract, generic repository, universal response envelope, route or capability descriptor, or
production registration.

Passing this lane returns evidence to the controller. It does not authorize `P1.S2`, `P1.1B`,
`P1.1C`, a successor worktree, a task refill, or any production transport work.

## Exact required reads

The `worker-start-v1` contract must list every path below exactly. Directory roots, globs, recursive
reads, and implicit sibling authority are invalid.

### Mandatory baseline, in reading order

- `AGENTS.md`
- `docs/hosted-web-phases/START_HERE.md`
- `docs/hosted-web-phases/EVIDENCE_LIFECYCLE.md`
- `docs/hosted-web-phases/README.md`
- `docs/hosted-web-phases/EXECUTION_INDEX.json`
- `docs/hosted-web-phases/phase-01/controller-packet.md`
- `docs/hosted-web-phases/phase-01/lanes/p1-s1-foundations.md`

### Mandatory documents and configuration inputs

- `CLAUDE.md`
- `AGENT_CRITICAL_GUARDRAILS.md`
- `docs/hosted-web-phases/phase-01/README.md`
- `docs/hosted-web-phases/phase-01/architecture-and-contracts.md`
- `docs/hosted-web-phases/phase-01/conformance-and-tests.md`
- `docs/research/hosted-web/phase-1/bootstrap/phase-start.json`
- `docs/research/hosted-web/phase-1/bootstrap/packet-revision.json`
- `docs/research/hosted-web/phase-1/bootstrap/ownership-manifest.json`
- `docs/research/hosted-web/phase-1/bootstrap/baseline-fingerprints.json`
- `docs/research/hosted-web/phase-1/bootstrap/estimate-allocation.json`
- `docs/research/hosted-web/phase-1/bootstrap/bootstrap-report.md`
- `package.json`
- `tsconfig.json`
- `vitest.config.ts`

There are no mandatory scripts or fixtures and no authority to read preserved Phase 0 evidence. The
accepted S0 evidence is read-only input: do not regenerate, reformat, rewrite, move, or delete it.

## Exact writable paths

- `.codex-handoff/phase-01-p1-1a.json`
- `src/shared/contracts/hosted/app-error.ts`
- `src/shared/contracts/hosted/identifiers.ts`
- `src/shared/contracts/hosted/index.ts`
- `src/shared/contracts/hosted/query-context.ts`
- `src/shared/contracts/hosted/revision.ts`
- `test/architecture/hosted-web/phase-1/contracts/app-error.test.ts`
- `test/architecture/hosted-web/phase-1/contracts/fixtures/invalid-contract-values.json`
- `test/architecture/hosted-web/phase-1/contracts/fixtures/valid-contract-values.json`
- `test/architecture/hosted-web/phase-1/contracts/identifiers.test.ts`
- `test/architecture/hosted-web/phase-1/contracts/query-context.test.ts`
- `test/architecture/hosted-web/phase-1/contracts/revision.test.ts`

Everything else is read-only. In particular, do not edit package or lock files, TypeScript or lint
configuration, any other `src/` file, production composition/registration, another lane's paths, or
the six accepted S0 evidence paths. No new dependency is authorized.

## Frozen deliverables

- `P1.1A.KERNEL`: small value-only primitives for opaque identifiers, query context, revision/cursor,
  and safe application errors, exported through the exact shared-kernel entrypoint.
- `P1.1A.VERSION`: positive and deliberate negative tests for parsing, kind/scope separation,
  revisions/cursors, safe errors, schema/version behavior, and cancellation/deadline context.
- Negative fixture: `P1.NEG.SCHEMA_VERSION`, with expected diagnostic
  `phase1-schema-version-invalid-or-unsupported`.
- Unique estimate bucket: 180-300 gross changed lines. Stop for controller review before exceeding
  300 lines; do not shrink required behavior merely to meet the estimate.

The kernel must not export a feature DTO, `ApiResponse<T>`, `Repository<T>`, `PlatformAdapter`,
route or capability metadata, HTTP status, IPC result, provider value, filesystem/path value, or
production identity claim. Fixture `TeamId` values are synthetic and test-only.

## Acceptance

1. Contracts import no Electron, Fastify, React, Zustand, Node infrastructure, `@main`, renderer,
   preload, filesystem/path/process, provider SDK, or transport type.
2. Opaque identifier constructors reject empty, oversized, malformed, raw-cross-kind, and unsafe
   values; tests never claim that a legacy team name is a production `TeamId`.
3. Revisions and cursors remain equality-only opaque values. They are not parsed, incremented, sorted,
   or used as display/cache keys.
4. `QueryContext` contains only validated actor/session, deployment/boot, request, authorized scope,
   deadline/cancellation values. It contains no cookies, headers, IPs, Electron events, paths, or
   global auth lookup.
5. `SafeAppError` uses only the frozen application codes and bounded safe fields. Raw messages,
   stacks, host paths, secrets, provider output, command bodies, and transport status cannot escape.
6. Same-version response parsing may ignore additive unknown fields after known-field validation;
   input objects reject unknown fields, and malformed, missing, future, or incompatible versions fail
   with the stable schema-version diagnostic.
7. Every exported primitive has a demonstrated P1.S1 use; no empty ceremonial layer or sixth
   primitive family is added.
8. No route/catalog, capability, conformance harness, ratchet, feature slice, transport adapter,
   production registration, filesystem adapter, migration, renderer change, or dependency change is
   created.

## Required checks

Run from the bound `workspaceRoot` and record command, exit code, and relevant tool version in the
handoff:

```bash
pnpm exec vitest run test/architecture/hosted-web/phase-1/contracts
pnpm lint:fast:files -- src/shared/contracts/hosted/app-error.ts src/shared/contracts/hosted/identifiers.ts src/shared/contracts/hosted/index.ts src/shared/contracts/hosted/query-context.ts src/shared/contracts/hosted/revision.ts test/architecture/hosted-web/phase-1/contracts/app-error.test.ts test/architecture/hosted-web/phase-1/contracts/identifiers.test.ts test/architecture/hosted-web/phase-1/contracts/query-context.test.ts test/architecture/hosted-web/phase-1/contracts/revision.test.ts
pnpm typecheck
pnpm exec prettier --check .codex-handoff/phase-01-p1-1a.json src/shared/contracts/hosted/app-error.ts src/shared/contracts/hosted/identifiers.ts src/shared/contracts/hosted/index.ts src/shared/contracts/hosted/query-context.ts src/shared/contracts/hosted/revision.ts test/architecture/hosted-web/phase-1/contracts/app-error.test.ts test/architecture/hosted-web/phase-1/contracts/fixtures/invalid-contract-values.json test/architecture/hosted-web/phase-1/contracts/fixtures/valid-contract-values.json test/architecture/hosted-web/phase-1/contracts/identifiers.test.ts test/architecture/hosted-web/phase-1/contracts/query-context.test.ts test/architecture/hosted-web/phase-1/contracts/revision.test.ts
git diff --check
git status --short
```

Also compare the changed-path set to the twelve exact writable paths, confirm `package.json`,
`pnpm-lock.yaml`, configs, accepted S0 evidence, and every non-owned path are unchanged, and scan every
changed/untracked file for secrets, auth/provider payloads, private/home paths, raw command/runtime
bodies, and real-project names. Confirm no new import reaches a forbidden layer or filesystem/process
API. A zero-match text scan without untracked-file coverage is insufficient.

## Stop conditions

Stop with a named blocker on stale base/revision, a phase start that does not contain this transition,
changed S0 evidence, path overlap, unclassified baseline failure, source/packet contradiction, new
dependency or config need, unsafe evidence, secret/private-path finding, production transport
exposure, filesystem/path-taking work, identity invention, or any attempt to start `P1.S2`.

## Handoff

Write `.codex-handoff/phase-01-p1-1a.json` using the runtime `PACKET_STANDARD` result schema.
Include the exact base/start SHA, packet revision, evidence IDs and proof levels, changed paths,
commands and exit codes, deliberate negative result, estimate actual, unverified production claims,
blockers, and the smallest next controller action. Return only `verified`, `characterized`, `blocked`,
or `failed`; never claim Phase 1 or production hosted behavior complete.
