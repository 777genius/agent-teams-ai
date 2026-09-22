# P1.R2 list semantics formal review

> **Post-freeze amendment (2026-07-16).** A post-freeze review fix moved `QueryContext` out of
> the wire request: `ListTeamLifecycleRequest` is now `{ schemaVersion, cursor, expectedRevision }`
> only, and the host assembles the context and passes it to `execute(request, context)` separately.
> Statements below about request parsing validating a nested query context describe the reviewed
> pre-fix snapshot, not the current contract.

Disposition: ACCEPT

Finding counts: P0 0 / P1 0 / P2 0.

## Reviewer and independence

- Identity: `codex-thread:019f64ac-241c-7ee3-8ec8-7ba99c7360fa`
- Controller job: `agent-teams-hosted-web-refactor-p1-r2-formal-review-v17-r3`
- Worktree: `/var/data/agent-teams-hosted-web-refactor/worktrees/p1-r2-formal-review-v17-r3`
- Profile: model `gpt-5.6-sol`, reasoning effort `xhigh`, service tier `default`, Fast disabled
- Capacity: one fresh reviewer; no concurrent duplicate
- Independence: the root/controller admission allocated this fresh r3 identity, isolated job, and
  isolated worktree as distinct from (1) the P1.R2 router author, (2) all P1.1A/P1.1D producers,
  remediation workers, and reviewers, (3) all PR #252 conflict-resolution producers and reviewers,
  and (4) every prior Phase 1 formal reviewer.

## Authority and provenance

- Router-authoring provenance only: `packetBaseSha`
  `48d79e2b13e258fc82ad55723875f15d6e162872`.
- Resolved `postIntegrationAuthoritySha`, broker-returned-and-pushed commit,
  `expectedSourceCommit`, base, canonical, plan bundle, phase start, and local `HEAD` are all
  `f6794b607609c57dc92def696d05946c9c96856a`.
- Root immutable pre-start attestation: remote `origin`, ref
  `refs/heads/refactor/hosted-web-feature-boundaries`, command
  `git ls-remote origin refs/heads/refactor/hosted-web-feature-boundaries`, exit `0`, exact output
  `f6794b607609c57dc92def696d05946c9c96856a\trefs/heads/refactor/hosted-web-feature-boundaries`,
  equality `true`, canonical worktree clean `true`, and admission `expectedSourceCommit`
  `f6794b607609c57dc92def696d05946c9c96856a`.
- Local authority checks retained `HEAD` equality. No reviewer remote or network query was made.
- Separate `reviewedProductSnapshotSha`:
  `666042037a9c91df572b1d8274bf6024f8d00f40`.
- Ordered snapshot parents:
  `c3135d40c6e70e4b2ddc905dc815407397197634`, then
  `3b48f9391b4bff1d82bc85ef01a2d5e0e5b50e95`.
- PR #252 conflict gate and P1.1D remain accepted predecessors.
- Controller/lane packet hashes matched the execution index:
  `9b4b27f5029df8e21214fe6d4a372cbfc3e6d6c6f6506351954243026c33291d` and
  `8b089ab8337467da201be884fc8f52bfff6d6377f63722f6f8d1aa6d5f6778c3`.

## Exact scope

The execution-index manifest proved 12 P1.1A + 9 P1.1D + 11 semantic-corpus = 32 paths, with 32
distinct entries. `git diff --exit-code 666042037a9c91df572b1d8274bf6024f8d00f40 HEAD --
"${review_input_paths[@]}"` exited `0`, proving every reviewed input byte-identical at the snapshot
and authority `HEAD`. `git diff --exit-code HEAD -- "${review_input_paths[@]}"` also exited `0`.

Both evidence outputs were initially absent. The initial canonical status was empty. Final status is
exactly these two untracked writer-authority paths, in lexical Git order, with no staged or tracked
diff:

1. `.codex-handoff/phase-01-p1-r2.json`
2. `docs/research/hosted-web/phase-1/reviews/list-semantics.md`

## Semantic findings

1. Pass — request parsing admits only the exact versioned top-level and nested context fields,
   rejects unknown own string and symbol keys, validates actor/session/deployment/boot/request IDs,
   authorized scope, deadline, and cancellation, and performs no ambient authorization lookup.
2. Pass — `ListTeamLifecycle` invokes its injected value-only source exactly once per valid request
   and zero times for an invalid request. Its product surface contains no filesystem, adapter,
   transport, runtime, provider, production mount, or global-state dependency.
3. Pass — same-version success, failure, and inapplicable responses validate all known fields before
   additive discard and return fresh frozen known-field-only projections, including item and safe
   error projections. Additive own string and symbol fields are not retained.
4. Pass — the success parser captures the untrusted item length once, rejects values above 1,000,
   rejects sparse and duplicate-ID arrays, reads each dense index once, parses each item, and builds a
   fresh plain array. It does not dispatch input-owned map, iterator, constructor, or species
   behavior; deterministic sort and freeze operate on the trusted array.
5. Pass — all ten manifest scenarios retain the accepted outcome, deterministic order,
   revision/cursor values, safe fields, retryability, and empty-versus-error distinction. The
   deliberate mismatch still rejects with `phase1-semantic-outcome-drift`.
6. Pass — safe errors remain limited to accepted application categories and bounded safe fields.
   Unsupported versions, malformed known fields, source throws, and invalid source responses fail
   closed with static reasons/diagnostics and no raw messages, stacks, authorization/provider data,
   command bodies, or private paths.
7. Pass — revisions and cursors remain opaque, kind-separated tokens. The contract does not parse,
   increment, sort, derive, or use them as display/cache keys and never converts an invalid cursor to
   page one. Production cursor integrity, scope, and snapshot binding remain unverified.
8. Pass — the two public feature entrypoints expose the narrow team-lifecycle contract and use case.
   They expose no legacy aggregate, universal envelope, transport status, route/capability metadata,
   provider/path values, production identity, or implementation-file entrypoint.
9. Pass — the shared kernel remains exactly five product files and five primitive families. The five
   files total exactly 159 lines and 7,242 bytes and are unchanged from the reviewed snapshot. The
   accepted P1.1A handoff remains 299 gross owned lines. No sixth primitive family or unproved export
   was found.
10. Pass — `P1.NEG.SCHEMA_VERSION` still rejects with
    `phase1-schema-version-invalid-or-unsupported`; its valid same-version neighbors pass. No
    production authorization, transport parity, adapter integrity, filesystem/runtime integration,
    production mount, or full Phase 1 completion is claimed.

There are no P0, P1, or P2 findings.

## Commands and observations

- Focused command:
  `pnpm exec vitest run test/architecture/hosted-web/phase-1/contracts test/features/team-lifecycle`
  — exit `0`; Vitest `3.2.6`; exactly 5/5 files and 14/14 tests passed.
- `pnpm typecheck` — exit `1`; exactly seven inherited diagnostics, zero owned, zero unexpected:
  - `auth-artifacts-spike.test.ts` — TS7016 at 25:8; TS7031 at 66:31; TS18046 at 117:68;
    TS7031 at 413:48; TS7031 at 733:10.
  - `evidence-scanner.test.ts` — TS7016 at 12:8.
  - `scan-runtime-surfaces.test.ts` — TS2352 at 162:44.
- Exact 34-path Prettier check below — exit `0`; 34 files observed.

```bash
pnpm exec prettier --check \
  .codex-handoff/phase-01-p1-1a.json \
  src/shared/contracts/hosted/app-error.ts \
  src/shared/contracts/hosted/identifiers.ts \
  src/shared/contracts/hosted/index.ts \
  src/shared/contracts/hosted/query-context.ts \
  src/shared/contracts/hosted/revision.ts \
  test/architecture/hosted-web/phase-1/contracts/app-error.test.ts \
  test/architecture/hosted-web/phase-1/contracts/fixtures/invalid-contract-values.json \
  test/architecture/hosted-web/phase-1/contracts/fixtures/valid-contract-values.json \
  test/architecture/hosted-web/phase-1/contracts/identifiers.test.ts \
  test/architecture/hosted-web/phase-1/contracts/query-context.test.ts \
  test/architecture/hosted-web/phase-1/contracts/revision.test.ts \
  .codex-handoff/phase-01-p1-1d.json \
  src/features/team-lifecycle/contracts/team-lifecycle-read.ts \
  src/features/team-lifecycle/contracts/index.ts \
  src/features/team-lifecycle/core/application/ListTeamLifecycle.ts \
  src/features/team-lifecycle/core/application/index.ts \
  src/features/team-lifecycle/index.ts \
  test/features/team-lifecycle/core/ListTeamLifecycle.test.ts \
  test/architecture/hosted-web/phase-1/team-lifecycle/team-lifecycle-read-contract.test.ts \
  test/architecture/hosted-web/phase-1/team-lifecycle/team-lifecycle-read-boundaries.test.ts \
  test/fixtures/hosted-web/phase-1/team-lifecycle/manifest.json \
  test/fixtures/hosted-web/phase-1/team-lifecycle/outcomes/corrupt.json \
  test/fixtures/hosted-web/phase-1/team-lifecycle/outcomes/draft.json \
  test/fixtures/hosted-web/phase-1/team-lifecycle/outcomes/empty.json \
  test/fixtures/hosted-web/phase-1/team-lifecycle/outcomes/not-found-inapplicable.json \
  test/fixtures/hosted-web/phase-1/team-lifecycle/outcomes/partial.json \
  test/fixtures/hosted-web/phase-1/team-lifecycle/outcomes/provisioning-inapplicable.json \
  test/fixtures/hosted-web/phase-1/team-lifecycle/outcomes/stale.json \
  test/fixtures/hosted-web/phase-1/team-lifecycle/outcomes/success.json \
  test/fixtures/hosted-web/phase-1/team-lifecycle/outcomes/unavailable.json \
  test/fixtures/hosted-web/phase-1/team-lifecycle/outcomes/unexpected.json \
  .codex-handoff/phase-01-p1-r2.json \
  docs/research/hosted-web/phase-1/reviews/list-semantics.md
```

- `git diff --check` — exit `0`.
- `git diff --cached --quiet` — exit `0`.
- `git diff --exit-code` — exit `0`.
- `git status --short` — exit `0`; exactly the two untracked output paths listed above.
- Shared-kernel `wc -l -c` — exit `0`; total 159 lines and 7,242 bytes.

## Classified scans

All scans used the same exact 34-path array: all 32 reviewed inputs plus both outputs.

- Secret/credential scan
  `rg -n -i '(api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password|bearer)'`:
  exit `0`, two match lines. Both are the required scan-command text recorded in the two reviewer
  outputs; neither is a credential or secret value.
- Provider-term scan
  `rg -n -i '(provider|anthropic|claude|openai|opencode|gpt-[0-9])'`: exit `0`, 17 match lines. Every
  match is classified as required model/profile metadata, prior-process provenance or
  safety/unverified-boundary labels in the P1.1D handoff, synthetic forbidden-surface
  negative-control text in the boundary test, or scan-command/classification text in these two
  outputs. No match is a provider payload or raw provider value.
- Private-path scan
  `rg -n '(/Users/|/home/|/root/|~/|[A-Za-z]:\\Users\\|real[-_ ]project)'`: exit `0`, two match
  lines. Both are the required scan-command text recorded in the two reviewer outputs; neither is a
  private user path or user-project path value.

## Unverified and blocked boundaries

Production authorization; production cursor integrity, scope, and snapshot binding; transport
parity; adapters; IPC/HTTP, preload, and renderer behavior; filesystem/runtime integration;
production mounts; full Phase 1 completion; and Phase 2+ behavior remain unverified.

P1.I, P1.F, Phase 2+, all product workers, integration, and successor controllers remain blocked.
Only a later separately reviewed docs router may authorize P1.I, and it must not reintegrate either
P1.R2 evidence path. Next action is `controller-hold`. Terminal state is `HOLD`.
