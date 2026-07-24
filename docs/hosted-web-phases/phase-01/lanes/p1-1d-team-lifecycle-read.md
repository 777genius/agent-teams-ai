# P1.1D transport-neutral team-lifecycle read/list lane

## Authority and provenance

- Phase/node: `phase-01` / `P1.1D`
- Lane ID: `p1-1d`
- Packet revision: `phase-01-p1-1d-team-lifecycle-read-r1`
- Canonical base: `759a5d4f45c2142485a0acc13760f3de4d0ff6ea`
- Accepted predecessor: formal P1.R1 `ACCEPT`, policy-integrated at the canonical base
- Formal reviewer: `agent-teams-hosted-web-refactor-p1-r1-review-v16-r1`
- Accepted review result: routes 16/16, conformance 13/13, P0/P1/P2 findings 0/0/0
- Handoff path: `.codex-handoff/phase-01-p1-1d.json`
- Evidence IDs:
  - `P1.1D.TEAM_LIFECYCLE_READ_CONTRACT`
  - `P1.1D.TEAM_LIFECYCLE_READ_USE_CASE`
  - `P1.1D.TEAM_LIFECYCLE_SEMANTIC_PROOF`

This packet becomes executable only after the exact seven-path router containing it is
policy-integrated and its successor controller reports exactly `live=true`. It authorizes one serial
producer, not a review, integration, transport, mount, launch implementation, or successor.

## Mission

Implement the first narrow team-lifecycle read/list contract and application proof. Reuse the accepted
hosted shared kernel for opaque IDs, request/query context, revisions/cursors, and safe AppError
categories. Add runtime parsing with explicit version and unknown-field behavior. Drive one pure list
use case through test-owned in-memory values and prove deterministic semantic outcomes against the
accepted synthetic corpus.

Close exactly the P1.1D-owned gaps left by P1.R1:

1. prove `P1.NEG.SEMANTIC_OUTCOME` with a deliberate mismatched outcome and adjacent valid outcomes;
2. provide the narrow feature-owned DTO/use-case positive neighbor for
   `P1.NEG.LEGACY_GOD_DTO`; and
3. provide the value-only application-port/in-memory-test positive neighbor for
   `P1.NEG.NO_FILESYSTEM_ADAPTER_PHASE1`.

Do not implement a driving or driven production adapter. No behavior in this packet is mounted into
the app.

## Exact mandatory reads

Read in this order. Directory reads, globs, implicit siblings, recursive documentation/research reads,
and the whole master plan are not authorized:

1. `AGENTS.md`
2. `docs/hosted-web-phases/START_HERE.md`
3. `docs/hosted-web-phases/EVIDENCE_LIFECYCLE.md`
4. `docs/hosted-web-phases/README.md`
5. `docs/hosted-web-phases/EXECUTION_INDEX.json`
6. `docs/hosted-web-phases/phase-01/controller-packet.md`
7. `docs/hosted-web-phases/phase-01/lanes/p1-1d-team-lifecycle-read.md`
8. `CLAUDE.md`
9. `AGENT_CRITICAL_GUARDRAILS.md`
10. `src/features/CLAUDE.md`
11. `docs/hosted-web-phases/PACKET_STANDARD.md`
12. `docs/hosted-web-phases/phase-01/execution-dag.md`
13. `docs/FEATURE_ARCHITECTURE_STANDARD.md`
14. only the two headings `Phase 1 work packages: create one contract system, not another mega-API`
    and `Phase 1: single-source contracts and conformance` in
    `docs/hosted-web-e2e-completion-plan.md`
15. `docs/research/hosted-web/phase-1/reviews/routes-ratchets.md`
16. `src/shared/contracts/hosted/index.ts`
17. `src/shared/contracts/hosted/app-error.ts`
18. `src/shared/contracts/hosted/identifiers.ts`
19. `src/shared/contracts/hosted/query-context.ts`
20. `src/shared/contracts/hosted/revision.ts`
21. `src/main/composition/hosted/routing/route-types.ts`
22. `test/architecture/hosted-web/phase-1/conformance/semantic-harness.ts`
23. `test/architecture/hosted-web/phase-1/conformance/semantic-harness.test.ts`
24. `scripts/hosted-web/phase-1/check-feature-dependencies.ts`
25. `test/architecture/hosted-web/phase-1/dependencies/feature-dependencies.test.ts`
26. `test/fixtures/hosted-web/phase-1/team-lifecycle/manifest.json`
27. `test/fixtures/hosted-web/phase-1/team-lifecycle/outcomes/corrupt.json`
28. `test/fixtures/hosted-web/phase-1/team-lifecycle/outcomes/draft.json`
29. `test/fixtures/hosted-web/phase-1/team-lifecycle/outcomes/empty.json`
30. `test/fixtures/hosted-web/phase-1/team-lifecycle/outcomes/not-found-inapplicable.json`
31. `test/fixtures/hosted-web/phase-1/team-lifecycle/outcomes/partial.json`
32. `test/fixtures/hosted-web/phase-1/team-lifecycle/outcomes/provisioning-inapplicable.json`
33. `test/fixtures/hosted-web/phase-1/team-lifecycle/outcomes/stale.json`
34. `test/fixtures/hosted-web/phase-1/team-lifecycle/outcomes/success.json`
35. `test/fixtures/hosted-web/phase-1/team-lifecycle/outcomes/unavailable.json`
36. `test/fixtures/hosted-web/phase-1/team-lifecycle/outcomes/unexpected.json`

All mandatory inputs are read-only. The P1.R1 result is provenance and accepted disposition, not
permission to inspect sibling research evidence or rewrite a finding.

## Dependencies and frozen facts

The producer must preserve these dependency facts:

- the accepted shared kernel comes from P1.1A and is reused rather than copied or widened;
- RouteDescriptor and capability assertions remain separate, frozen P1.1B inputs;
- the semantic harness, dependency scanner, and fixture corpus remain P1.1C test inputs, never product
  dependencies;
- P1.R1 accepted the existing routes 16/16 and conformance 13/13 with no P0/P1/P2 finding; and
- IPC/HTTP parity, route registration, renderer consumption, production mounts, review, integration,
  and later-phase behavior remain future work.

If a required outcome cannot be proved without changing an accepted input or adding a dependency,
adapter, transport, fixture, or configuration path, stop with `packet_conflict`.

## Exact exclusive writer authority

### Product paths: exactly five

1. `src/features/team-lifecycle/contracts/team-lifecycle-read.ts`
2. `src/features/team-lifecycle/contracts/index.ts`
3. `src/features/team-lifecycle/core/application/ListTeamLifecycle.ts`
4. `src/features/team-lifecycle/core/application/index.ts`
5. `src/features/team-lifecycle/index.ts`

### Test paths: exactly three

1. `test/features/team-lifecycle/core/ListTeamLifecycle.test.ts`
2. `test/architecture/hosted-web/phase-1/team-lifecycle/team-lifecycle-read-contract.test.ts`
3. `test/architecture/hosted-web/phase-1/team-lifecycle/team-lifecycle-read-boundaries.test.ts`

### Handoff paths: exactly one

1. `.codex-handoff/phase-01-p1-1d.json`

The five-product, three-test, and one-handoff sets are mutually disjoint and contain exactly nine
paths. The producer may create their parent directories but may place no other file in them. Every
other tracked or untracked path is read-only. An extra path is a stop condition, not cleanup or repair
authority.

In particular, do not modify shared contracts, RouteCatalog/capability files, semantic harness or
fixture inputs, dependency scanners, IPC/HTTP/preload/renderer code, filesystem/infrastructure or
composition code, package/lock/config files, existing handoffs, router docs, or research evidence.

## Contract deliverable

`contracts/team-lifecycle-read.ts` owns one versioned, browser-safe list contract and its runtime
parsers. It must:

1. reuse, by import, the accepted opaque identifier, query/request context, revision/cursor, and
   AppError-category primitives that apply; it must not duplicate their wire shapes;
2. define only the request, narrow list item, success result, and safe feature-local failure surface
   needed by this one read;
3. treat input as `unknown` at the parsing boundary and make supported schema version and unknown-field
   behavior explicit and deterministic;
4. reject malformed IDs, revisions/cursors, versions, item shapes, and semantic states with safe
   structured errors rather than raw-message matching;
5. exclude filesystem paths, working directories, command/runtime bodies, auth/provider payloads,
   secrets, Electron/renderer values, and task/member/message/session/provider aggregates; and
6. remain DTO/parser code only, with no store access, orchestration, side effect, environment lookup,
   transport, test fixture, or framework dependency.

The two contract entrypoints export only this supported narrow surface. No wildcard implementation
export and no mega `TeamsAPI`, `ElectronAPI`, all-parity, or legacy god DTO is permitted.

## Application deliverable

`core/application/ListTeamLifecycle.ts` owns one source port and one list use case. It must:

1. accept and return contract values, invoke the injected source port exactly once per request, and
   keep source/transport/runtime types outside the public application surface;
2. parse at the contract boundary and normalize failures to the accepted safe AppError categories;
3. preserve opaque identity and revision/cursor meaning without exposing a path or runtime handle;
4. return deterministic ordering and deterministic success/failure classification for identical
   inputs;
5. have no Electron, Fastify, React, Zustand, Node filesystem/path/process, `@main`, adapter,
   infrastructure, global state, clock, network, or side-effect dependency; and
6. be exported only through the two narrow application/root public entrypoints.

The only source implementation in this node is a test-owned in-memory value in an owned test file.
Do not add a product in-memory adapter, mock transport, fake browser/server, filesystem adapter, IPC
handler, HTTP route/client, preload bridge, renderer hook/UI, route descriptor, or production
composition.

## Exact positive semantics

The owned tests must prove all of these behaviors against the immutable manifest and ten outcome
fixtures:

1. a valid empty result parses and returns an empty list without inventing an error;
2. valid success, draft, partial, stale, and explicitly inapplicable states retain their fixture-defined
   semantic classification and only the narrow safe fields;
3. corrupt, unavailable, and unexpected inputs become the fixture-defined safe structured failure
   outcome without raw message matching or leaked input;
4. identical values produce identical ordering, cursor/revision treatment, and normalized outcome;
5. unsupported version, unknown-field behavior, malformed identifier, malformed revision/cursor, and
   malformed item/state follow the contract's explicit accept/reject rules;
6. the use case calls a test-owned in-memory port, has no filesystem dependency, and passes the clean
   value-only neighbor used by the accepted dependency scanner; and
7. a caller can use the narrow public feature entrypoint without importing an implementation folder,
   legacy team aggregate, transport, Electron surface, or `@main` module.

The fixture manifest is authoritative for which scenario is success, failure, or inapplicable. Tests
must not rewrite or reinterpret fixture bytes to make an assertion pass.

## Exact negative and positive-neighbor semantics

| Negative ID                           | Required rejection                                                                                                                                                                                          | Required P1.1D positive neighbor                                                                                                                               |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `P1.NEG.SEMANTIC_OUTCOME`             | A deliberate mismatch of fixture-defined success/error/inapplicable semantics rejects with exact diagnostic `phase1-semantic-outcome-drift`.                                                                | Actual parsed/use-case outcomes for all ten immutable scenarios match the manifest and are accepted.                                                           |
| `P1.NEG.LEGACY_GOD_DTO`               | The boundary test rejects an owned synthetic source string that adds a broad team/member/task/message/session/provider/runtime aggregate with exact inherited diagnostic `phase1-legacy-god-dto-forbidden`. | The new contract exposes only its request, narrow item/result, parser, and safe feature-local error surface through public entrypoints.                        |
| `P1.NEG.NO_FILESYSTEM_ADAPTER_PHASE1` | The boundary test rejects an owned synthetic source string that imports or models a filesystem/path adapter with exact inherited diagnostic `phase1-filesystem-adapter-forbidden`.                          | The pure injected source port and test-owned in-memory value prove the list use case with no filesystem, path, process, adapter, or infrastructure dependency. |

The negative strings live only inside the owned boundary test; do not create fixtures. A diagnostic
change, a non-rejecting negative, a false positive-neighbor claim, or weakened inherited scanner is a
failure. Do not claim IPC-versus-HTTP parity, production support, renderer behavior, a production
adapter, or all-feature conformance.

## Architecture and boundary gates

The three owned tests must additionally prove:

1. all product imports follow `docs/FEATURE_ARCHITECTURE_STANDARD.md` and public entrypoint rules;
2. contracts import no Electron, Fastify, React, Zustand, Node built-in, `@main`, adapter,
   infrastructure, renderer, preload, test, fixture, or research module;
3. core application imports only its contracts and permitted pure shared contracts, with no side
   effect or process-owned dependency;
4. the fixture corpus and semantic harness are test-only inputs and never reachable from product
   entrypoints;
5. there is no new `main/`, `preload/`, `renderer/`, `adapters/`, `infrastructure/`, route/catalog,
   app-shell, or production registration path; and
6. the full owned product surface remains path-free, secret-free, transport-neutral, and browser-safe
   without pretending to implement browser mode.

Electron desktop remains the default real app target, but this packet runs no app or runtime. The
renderer is not involved. Transport and filesystem responsibilities remain outside this node.

## Focused required checks

Run each command independently from the bound source worktree and record its exact exit code and test
counts in the handoff:

```bash
pnpm exec vitest run test/features/team-lifecycle/core/ListTeamLifecycle.test.ts
pnpm exec vitest run test/architecture/hosted-web/phase-1/team-lifecycle/team-lifecycle-read-contract.test.ts
pnpm exec vitest run test/architecture/hosted-web/phase-1/team-lifecycle/team-lifecycle-read-boundaries.test.ts
pnpm exec vitest run test/architecture/hosted-web/phase-1/conformance/semantic-harness.test.ts test/architecture/hosted-web/phase-1/dependencies/feature-dependencies.test.ts
pnpm lint:fast:files -- src/features/team-lifecycle/contracts/team-lifecycle-read.ts src/features/team-lifecycle/contracts/index.ts src/features/team-lifecycle/core/application/ListTeamLifecycle.ts src/features/team-lifecycle/core/application/index.ts src/features/team-lifecycle/index.ts test/features/team-lifecycle/core/ListTeamLifecycle.test.ts test/architecture/hosted-web/phase-1/team-lifecycle/team-lifecycle-read-contract.test.ts test/architecture/hosted-web/phase-1/team-lifecycle/team-lifecycle-read-boundaries.test.ts
pnpm typecheck
pnpm exec prettier --check src/features/team-lifecycle/contracts/team-lifecycle-read.ts src/features/team-lifecycle/contracts/index.ts src/features/team-lifecycle/core/application/ListTeamLifecycle.ts src/features/team-lifecycle/core/application/index.ts src/features/team-lifecycle/index.ts test/features/team-lifecycle/core/ListTeamLifecycle.test.ts test/architecture/hosted-web/phase-1/team-lifecycle/team-lifecycle-read-contract.test.ts test/architecture/hosted-web/phase-1/team-lifecycle/team-lifecycle-read-boundaries.test.ts .codex-handoff/phase-01-p1-1d.json
git diff --check
git status --short
```

The three new focused test files and the two accepted focused ratchet files must pass. Lint, Prettier,
and diff must be green. `pnpm typecheck` may exit 1 only for exactly the seven unchanged inherited
Phase 0 diagnostics accepted by P1.R1 in these three files, with no diagnostic in a P1.1D-owned path:

- `test/architecture/hosted-web/phase-0/auth-artifacts/auth-artifacts-spike.test.ts`
- `test/architecture/hosted-web/phase-0/host-primitives/evidence-scanner.test.ts`
- `test/architecture/hosted-web/phase-0/provider-runtime/scan-runtime-surfaces.test.ts`

Any new, moved, removed, or changed inherited diagnostic fails the gate. Do not run an app, browser,
Electron, HTTP server, IPC smoke, real project, provider/runtime, or filesystem integration check.

## Safety, scope, and ownership gates

Before handoff:

1. prove `HEAD` and the runtime `baseSha`/`phaseStartSha` bindings match this packet;
2. prove the diff from `phaseStartSha` contains exactly the nine owned paths and no accepted-input
   edit;
3. validate the handoff JSON, evidence IDs, packet revision, base/start provenance, changed-path list,
   proof levels, negative matrix, commands, and next action;
4. compute and record SHA-256 for every non-handoff owned path and a deterministic patch hash in exact
   owned-path order;
5. scan all nine owned paths for credentials, secrets, auth/provider payloads, private/home/real-project
   paths, raw command/runtime bodies, and binary content, classifying every lexical match; and
6. require status to resolve to exactly the nine owned paths, with nothing staged.

A secret, private path, binary, raw payload, staging, extra path, provenance mismatch, or unclassified
workspace change is a failure and stop condition. The producer may not clean, repair, stage, commit,
or push outside its contract.

## Evidence and proof contract

The handoff maps evidence as follows:

| Evidence ID                           | Required owned evidence                                       | Required proof level |
| ------------------------------------- | ------------------------------------------------------------- | -------------------- |
| `P1.1D.TEAM_LIFECYCLE_READ_CONTRACT`  | the two contract files plus contract-focused test             | `target_verified`    |
| `P1.1D.TEAM_LIFECYCLE_READ_USE_CASE`  | the use-case/application/root entrypoint files plus core test | `target_verified`    |
| `P1.1D.TEAM_LIFECYCLE_SEMANTIC_PROOF` | the two architecture tests and recorded focused checks        | `target_verified`    |

No evidence ID may name an immutable input as produced evidence. A missing owned path, non-green
required proof, or `fixture_characterized`/`unverified` proof level cannot close this lane.

## Structured handoff contract

Write only `.codex-handoff/phase-01-p1-1d.json`. It must be valid JSON and follow
`PACKET_STANDARD.md`, including:

1. `schemaVersion: 1`, `phaseId: "phase-01"`, `laneId: "p1-1d"`, and packet revision
   `phase-01-p1-1d-team-lifecycle-read-r1`;
2. runtime-bound `baseSha`, `planBundleCommit`, and `phaseStartSha`, with canonical base
   `759a5d4f45c2142485a0acc13760f3de4d0ff6ea`;
3. status `verified` only when every gate passes;
4. exactly the three evidence IDs, their exact owned paths, and `target_verified` proof levels;
5. `changedPaths` containing exactly the five product, three test, and one handoff paths in packet
   order, with no duplicate;
6. every required check command, exact exit code, and observed test count;
7. a negative-result matrix containing exactly the three rows above, exact diagnostics, and positive
   neighbor results;
8. per-file SHA-256 values, deterministic patch hash, ownership and safety results, and P0/P1/P2
   findings or explicit zero counts;
9. unverified claims for IPC/HTTP parity and adapters, preload/renderer behavior, filesystem/runtime
   integration, production mount, review/integration, Phase 1 completion, and Phase 2+; and
10. `nextAction: "review"`.

The handoff contains no secret, auth/provider payload, raw runtime body, private path, or fake success
claim. Do not create a second handoff or evidence file.

## Explicit stop conditions

Stop changing files and return the smallest `PACKET_STANDARD.md` blocker record when any of these is
true:

- the router is not policy-integrated, the successor controller is not `live=true`, or a runtime fact
  is stale/mixed;
- the base is not `759a5d4f45c2142485a0acc13760f3de4d0ff6ea` or an accepted input differs;
- another worker exists, an owned path overlaps another lane, or an extra changed/untracked path
  appears;
- implementation would require an IPC/HTTP/preload/renderer adapter, route/catalog edit, filesystem or
  infrastructure adapter, production mount, package/config/fixture/shared-kernel change, or fake
  browser;
- the narrow contract cannot express the manifest semantics without a legacy aggregate, path, secret,
  transport type, raw error matching, or source/runtime payload;
- a required negative does not reject with its exact diagnostic or its positive neighbor fails;
- a required check fails, the inherited typecheck set drifts, evidence cannot reach
  `target_verified`, or handoff provenance/hash/ownership is inconsistent;
- any real user project, provider/runtime, production data, credential, private path, or binary enters
  the work; or
- review, integration, commit, push, P1.R2, P1.I, P1.F, or Phase 2+ activity begins.

Use blocker class `packet_conflict`, `packet_stale`, `base_failure`, `environment`, `scope_overlap`,
`security`, `missing_evidence`, or `design_falsified` as applicable. Do not widen scope, silently
reinterpret semantics, weaken a ratchet, repair an immutable input, retry/refill, or continue on an
unrelated deliverable.

## Completion and return

Completion requires exactly nine owned changed paths, all three evidence IDs at `target_verified`,
every focused/quality/safety/ownership gate classified, the complete three-row negative matrix, and a
valid handoff with next action `review`. Return that handoff to the controller without staging,
committing, pushing, integrating, launching a reviewer/successor, or starting later work.

P1.R2, integration/P1.I, P1.F, and Phase 2+ remain blocked after producer completion. Only a later
reviewed, policy-integrated docs-only router with its own successor controller `live=true` may advance
authority.
