# Hosted Web Core v1 agent handoff - 2026-09-22

Snapshot time: `2026-09-22T17:57:22Z`.

## Source hierarchy

- Scope authority: `.codex-preserved/hosted-v1-goal-2026-08-31.md`.
- Scope file verified SHA-256: `97577e605b71803ac8cfe0def79c1d2df1faaa3a717d26b90689ae7bdcc17ccf`.
- Original orchestration handoff verified SHA-256: `646eb537b4b115cbd327df6d13a9d31242aff4ec0ea01168a313be49c36b39b6`.
- Current concise objective: `.codex-preserved/hosted-v1-continuation-goal-2026-09-22.md`.
- Chronological transfer ledger: `.codex-preserved/hosted-v1-transfer-2026-09-22.md`.

The August goal remains valid for scope, permissions, exclusions and Definition of Done. Its dated SHA and PR snapshot section is historical. Always prefer the current exact refs in this document after verifying them with `gh` and `git ls-remote`.

The September 5 handoff remains useful evidence, but its `fast` service tier and older model allocation are superseded. All new workers must use service tier `default`.

## Repository layout and what is pushed

The work is not on one branch.

- Accepted Product changes are on `777genius/agent-teams-ai` branch `refactor/hosted-web-feature-boundaries`, PR #252.
- Unreviewed or rejected Product candidates are isolated on `checkpoint/hosted-v1-*` branches in the same repo.
- Owner changes are in `777genius/agent_teams_orchestrator`, PR #45, with a separate rejected checkpoint branch.
- OpenCode changes are in `777genius/opencode-anomaly`, PR #3, with a separate rejected checkpoint branch.
- Transfer documents are on `777genius/agent-teams-ai` branch `checkpoint/hosted-v1-transfer-20260922`.

The main Mac checkout at `/Users/belief/dev/projects/agent-teams-ai/old-agent-teams-frontend` is very dirty with unrelated work. Do not reset, clean, stash, switch or commit it. Create a fresh isolated checkout or hosted workspace from an exact remote SHA. The temporary documentation worktree `/tmp/hosted-v1-transfer-update.xoTDKG` is not an authoritative long-lived workspace; the pushed branch is authoritative.

## Product PR #252

Fresh GitHub state at snapshot:

- PR: `https://github.com/777genius/agent-teams-ai/pull/252`
- Branch: `refactor/hosted-web-feature-boundaries`
- Exact head: `a57180016a6b3c82b02942cf40c19e3edd005d7e`
- Base `main`: `2d10b99b98e221994aaf1ecbdb9832c9be037ef5`
- State: open draft, conflicting with current main. Do not merge to legacy main in this goal.

Accepted and pushed final CI cleanup commits:

- `d3bc5f02ae5f9701cfd6a0deeef20c4abfbd9112` - exact-head regressions
- `f940961ac6e8a98582555fa77c094f9e800dd3b7` - source-size ratchets
- `4e2b16f82a688bb37ef501e2edd21686588e9de3` - host capability fixture alignment
- `76589127487c61c6bc1431d983b6c6044f4e1888` - remaining main lint rules
- `a57180016a6b3c82b02942cf40c19e3edd005d7e` - final project import groups

All verified commit identities are `iliya <iliyazelenkog@gmail.com>` and include `Refs #252`.

Exact-head CI run `35724512361`:

- Passed: validate, lint main, lint renderer, lint features, Hosted Core browser E2E, Phase 6 browser E2E, required team lifecycle UI, Windows task-ledger smoke.
- Failed: generic test shard 1/2, generic test shard 2/2, Phase 8 controller restart health confirmation.
- ReviewRouter failed in the external OAuth control plane.
- Phase 8 artifact ID `10693621571`, downloaded zip SHA-256 `29266b87e8476864119d547c0e317bfb0e2e680496652d9c230b39da83d43252`.
- Dominant generic test failures: malformed launch-state persistence, empty or undefined OpenCode permission publication, stale Phase 0 renderer inventory evidence, detached removal crash-reservation behavior and ProviderLaunchStress capability fixtures.

### Current CI remediation checkpoint

- Branch: `checkpoint/hosted-v1-ci-remed-r3880`
- Exact remote head: `1f58b78a3437195da0890c2c76b1c4e8eb8bd8bb`
- Exact base: Product head `a57180016a6b3c82b02942cf40c19e3edd005d7e`
- First producer patch SHA-256: `f074403eb5af17c8ed4dff0e8468ed7063954e8620ab76ed9972b4330043792e`
- Binding first review: REJECT with three P2 groups.
- Interrupted remediation overlay SHA-256: `572e77b835edabd4bc1c2e70b2136d21393a6c73daae0c7d922b70c92cacae40`
- Cumulative Product patch SHA-256: `425a4cc6614e106a939cf3cde642b42e23d09644f4246f89302ace2fac74ad73`
- Status: pushed, unreviewed, no terminal focused-test evidence.

The binding review of the first producer candidate found:

1. Detached removal recovery left the crash reservation and did not correctly republish captured writes.
2. `ProviderLaunchStress.live-e2e.test.ts` attempted privileged live proof scenarios in generic CI without capabilities.
3. Two guard tests failed before their intended invariants because of an incorrect credential-lock expectation and a missing wrapper launch receipt.

The interrupted overlay touches only `src/main/utils/durablePathOperations.ts` and `test/main/services/team/ProviderLaunchStress.live-e2e.test.ts`. It was being tested under the heavy lock when the old host stopped responding. The worker process and tmux session disappeared. Its stale `progress.json` still says running, but PID `2819932` is absent. Do not continue or duplicate that job. Treat the branch commit and exact frozen patches as its only output.

Evidence roots on the old host:

- Workspace: `/mnt/my_first_volume_ams3_1783285769353/pr252-product-ci-remed-r3880`
- Producer job: `/root/.cache/subscription-runtime/pr252-ci-remed-r3880`
- Review job: `/root/.cache/subscription-runtime/pr252-ci-review-r3881`
- Interrupted remediation: `/root/.cache/subscription-runtime/pr252-ci-remed-r3882`

Immediate next step: run a new independent `gpt-6-astra` low, default-tier, read-only review of the exact cumulative patch. Review durable reservation reconciliation and replay, idempotence, proof-group preservation in capability gating, intended guard validation, and the unchanged first-pass six-file fixes. Do not run tests in that review and do not accept from prose. If accepted, perform focused tests under the heavy lock. If rejected, remediate only the exact findings on a new isolated checkpoint.

### Other Product checkpoints

- `checkpoint/hosted-v1-contract-r3840` at `68e93a64a07be20ec898210a1ce3ea564fb18c1a` - completed, independent review required.
- `checkpoint/hosted-v1-e2e-r3858` at `eeabd1f5e7497ff1eb3d6a42ef70f6ec7d0146c1` - completed, independent review required.
- `checkpoint/hosted-v1-fs-r3850` at `e4aa7b50e33cb0b5ddab0b65ef59cd16a834cbed` - interrupted and unreviewed.
- `checkpoint/hosted-v1-phase10-r3856` at `0075cf32ca5cb64b4fd6db0d9d6231a7cb787e9d` - interrupted and unreviewed.

Do not merge checkpoint branches by name. Freeze and review the exact diff from the stated base, then adopt only an accepted coherent slice.

## PR #503 integration

Product PR #503 is merged:

- Former head: `2cd4d6b1134297f5609385a11b00f72054c1d8a7`
- Merge commit in the Product line: `3e4907e8454128a91ebb4ce8868fb56be55871c5`

The merge commit is already an ancestor of the current PR #252 line. The old objective to integrate #503 into #252 is complete. Do not cherry-pick or merge it again.

## Owner PR #45

- Repo: `777genius/agent_teams_orchestrator`
- PR: `https://github.com/777genius/agent_teams_orchestrator/pull/45`
- Branch: `feat/hosted-control-consolidation`
- Exact head: `6be17f9b779275f8db319e8ea33f10eb94b34a62`
- Base `dev`: `c6095ca4eb9f51a382eb6e6cd29019db187bebc0`
- State: open draft, mergeable but unstable.
- Latest head identity is correct and commit message includes `Refs 777genius/agent-teams-ai#252`.

Latest CI run `35670764943`:

- Passed: process containment on Linux and Windows, directory compatibility, Cursor managed plugin, task ledger and OpenCode conformance jobs.
- Failed: Hosted control and Windows packaged backfill candidate.
- Cancelled: selected-authority jobs.

Rejected checkpoint:

- Branch: `checkpoint/hosted-v1-owner-r3852`
- Head: `451fef2cf06c20366409ee15d1fb1e06a40c0a11`
- Remediation job: `/root/.cache/subscription-runtime/pr252-owner-remed-r3852` on the new host.
- Binding review job: `/root/.cache/subscription-runtime/pr252-owner-review-r3860`.
- Verdict: REJECT with 10 P1/P2 findings. Do not merge this checkpoint.

The rejected review covers repeated authority cleanup failure, live initializer bootstrap deletion, uninitialized stale-lease state, ambiguous post-rename durability failure, path replacement deletion, stale identity across rename retry, mutable executable reuse, Windows SID mismatch, uncancellable PowerShell operations and unbounded reads. Read the exact `latest-result.json` before remediation.

Continue from the current PR head and binding review evidence in a new isolated workspace. Do not merge to legacy `dev` in this goal.

## OpenCode PR #3

- Repo: `777genius/opencode-anomaly`
- PR: `https://github.com/777genius/opencode-anomaly/pull/3`
- Branch: `hosted-approval-11822`
- Exact head: `e0cc0ee53ac8446cd8502af2f415e03e2d8d204b`
- Base: `hosted-v11830-base` at `3104c1428ec91f809e5ab86631300de41eb6952e`
- State: open draft, mergeable but unstable.
- Latest head identity is correct and includes both required issue refs.

Latest workflow run `35685222054` failed Linux and Windows unit and E2E matrices. Standards and compliance checks passed. Inspect exact failed logs and artifacts before classifying each failure; do not assume all failures are caused by the two-file hosted patch.

Rejected checkpoint:

- Branch: `checkpoint/hosted-v1-opencode-r3855`
- Head: `6435377963a6722a0a197992b6c29ecdc4e2d9e5`
- Binding review job: `/root/.cache/subscription-runtime/pr252-opencode-review-r3855` on the old host.
- Follow-up manifest verification job: `/root/.cache/subscription-runtime/pr252-opencode-remed-r3862`.
- Verdict: REJECT with seven P2 findings. Do not merge this checkpoint.

The rejected review found wrong-process completion polling, abort-file recreation and leak, retained controls after fallback containment, a boundary regression that bypassed real acquisition, an already-expired late-publication retry deadline, a static process type mismatch, and incomplete process-exit/teardown bounds. Read the exact `latest-result.json` before a narrow remediation.

## Accepted runtime evidence

The r710 runtime proof was independently accepted by r712:

- Dynamic scenarios: 18/18.
- Result SHA-256: `5faa1dc2da296d3b4c6d29d2b00425bd0e036bfe30042eaf4c672f3580c8aedc`.
- Evidence root: `/mnt/volume_ams3_1784742570542/pr252-runtime-r710-exact-evidence-review-r712-acceptance/` on machine ID `be0aad971ea647fab370acd110b469b7`.

Reuse this immutable evidence for the exact runtime identity it proves. Do not rerun the 19 GB historical suite without a new specific gap.

## Hosts and subscription runtime

Old host:

- SSH alias: `codex-workers-eu-01-old`
- IP: `188.166.24.162`
- Machine ID: `93732118417e46618cefafc022c8b1db`
- Snapshot resources: 15 GiB RAM, 7.1 GiB available, 4 GiB swap fully allocated, 58 GiB free on `/`, 60 GiB free on the volume.
- Snapshot pressure: CPU low, I/O full `avg10=0.01`, memory full `avg10=0.00`.
- The previous SSH outage recovered without a web console or reboot.

New host:

- SSH alias: `codex-workers-eu-01`
- IP: `209.38.106.83`
- Machine ID: `be0aad971ea647fab370acd110b469b7`
- Snapshot resources: 15 GiB RAM, 10 GiB available, 15 GiB swap allocated, only 2 GiB free on `/`.
- Two GiB is below the user's accepted 5 GiB working threshold. Do not start a new heavy job there until space is safely restored without touching foreign state.

Full swap alone is not an admission blocker. Check active swapping, memory pressure, I/O pressure, available memory, disk and existing processes. Do not choose a host from load average alone. Never stop foreign processes.

Before every install, build or full test:

1. Recheck machine ID, RAM, swap activity, disk and `/proc/pressure/*`.
2. Inspect foreign heavy commands.
3. Acquire `/run/lock/hosted-v1-heavy.lock`.
4. Run at most one heavy command per physical host.

Runtime deployment:

- Current main.40 path on both hosts: `/var/data/runtimes/subscription-runtime/2d53ea63a54769567c6ac64e8658363ead638b43`.
- Main.40 failed before provider start because the deployment lacks `ajv`.
- Latest proven functional installed runtime: `/var/data/runtimes/subscription-runtime/587047d6e714ebf03609be084a06a59e57725fe6`.
- Functional CLI SHA-256: `7384296cfe3ec31cd9ac4f13d73ebd5058b99377c799050777a94eaa65f59f6d`.
- Preserve main.40 failure logs. Use the newest functional runtime until a newer deployment passes doctor and provider start.

Account availability changes quickly and differs by pool and host. A fresh local pool read at snapshot found scheduler-eligible `account-t` and `account-y`; other configured slots were in short cooldown or missing. This is not a permanent conclusion. Before every launch, call the supported pool discovery and status tools, inspect existing job `authRootDir` configuration without reading credentials, try `account-i` first when it exists as required, then automatically fall back through all scheduler-eligible identities after an actual failure. One 401 or quota result is not a pool-wide blocker.

## Worker profile and commit rules

- Hosted subscription-runtime workers only for implementation, code review and heavy work.
- Service tier `default` only. Never fast mode.
- Implementation: gpt-5.6 family, medium with a detailed bounded contract, otherwise high. Never use `gpt-5.6-sol` low.
- Planning, architecture criticism and code review: `gpt-6-astra` low by default.
- Raise Astra effort only for important complex audits. Do not use Astra for implementation or routine tests.
- Every writer has an isolated workspace and bounded owned paths. Reviewers are read-only and bind to an exact patch or commit SHA.
- Before each commit verify `git var GIT_AUTHOR_IDENT` and `git var GIT_COMMITTER_IDENT` both resolve to `iliya <iliyazelenkog@gmail.com>`.
- Conventional commit refs: Product `Refs #252`; Owner `Refs 777genius/agent-teams-ai#252`; OpenCode both `Refs 777genius/opencode-anomaly#3` and `Refs 777genius/agent-teams-ai#252`.
- Push each accepted slice immediately. Do not accumulate accepted unpushed changes.

## Safety invariants

- Runtime tests use only new disposable sandbox/test projects.
- Never open or exercise agent runtime flows in real user projects.
- Preserve dirty Mac checkouts, task evidence and foreign processes.
- Never use a legacy main/dev merge as a shortcut.
- Do not convert rejected checkpoint evidence into accepted code without a new exact review.
- A passed unit or fixture suite is not built-artifact E2E proof.
- Every accepted output follows `immutable output -> independent review -> adoption -> conventional commit -> push -> exact-head or exact-artifact proof`.

## Remaining Definition of Done

1. Accept and integrate the current Product exact-head remediation, then obtain green generic shards and classify/fix the Phase 8 controller restart failure.
2. Review and integrate the Product contract and E2E checkpoints.
3. Remediate and independently accept Owner and OpenCode, then prove their exact heads.
4. Complete filesystem durability and Phase 10 code/evidence.
5. Run four provider canaries on disposable projects.
6. Run one mixed-team built-artifact E2E on a disposable project.
7. Run all nine Core proof groups once: auth/security; lifecycle/process cleanup; durable effects/retry; SSE/restart; tasks/messages; workspace containment; capability degradation; runtime ingress; approvals.
8. Prove Phase 10 crash/restart, backup/restore into an empty target with authority rotation, rollback and terminal/process cleanup.
9. Bind signed exact artifacts, run final exact-head CI and receive independent GO without release-blocking findings.

Do not mark the goal complete because a worker finished, a patch exists, a checkpoint was pushed or a partial CI matrix is green.
