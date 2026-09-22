# Hosted Web Core v1 continuation goal - 2026-09-22

Complete Hosted Web Core v1 end-to-end from the current pushed checkpoints. Do not restart the historical campaign or treat a worker patch as completion.

Read these authorities before any write:

1. `.codex-preserved/hosted-v1-goal-2026-08-31.md`, SHA-256 `97577e605b71803ac8cfe0def79c1d2df1faaa3a717d26b90689ae7bdcc17ccf`, for product scope, permissions, exclusions and Definition of Done.
2. `.codex-preserved/hosted-v1-agent-handoff-2026-09-22.md` for the current exact refs, evidence, rejected candidates, host state and next actions.
3. `.codex-preserved/hosted-v1-transfer-2026-09-22.md` for the chronological transfer ledger.
4. The original handoff `/Users/belief/.codex/worker-feedback/handoffs/hosted-v1-orchestrator-handoff-2026-09-05.md`, verified SHA-256 `646eb537b4b115cbd327df6d13a9d31242aff4ec0ea01168a313be49c36b39b6`, only for historical evidence and lineage. Its old fast-mode and model instructions are superseded.

Start by freshly verifying GitHub refs, workspaces, job liveness, exact patch hashes, host machine IDs, resources and account pools. Preserve the dirty Mac checkout, foreign processes and all immutable evidence. Use only hosted subscription-runtime workers with service tier `default`; never use fast mode. Implementation uses a gpt-5.6 family model at medium with a detailed contract, otherwise high. Critical review uses `gpt-6-astra` low by default and higher effort only for genuinely critical audits. Explicitly set model, effort and service tier for every job. Start account fallback with `account-i` when configured, then use every scheduler-eligible slot after an actual quota, auth or capacity failure.

The first unfinished Product action is an independent exact review of branch `checkpoint/hosted-v1-ci-remed-r3880` at `1f58b78a3437195da0890c2c76b1c4e8eb8bd8bb`, compared with Product PR #252 head `a57180016a6b3c82b02942cf40c19e3edd005d7e`. The cumulative patch SHA-256 must be `425a4cc6614e106a939cf3cde642b42e23d09644f4246f89302ace2fac74ad73`. It is unreviewed and the previous focused test attempt was interrupted. Review its durable reservation reconciliation, capability gating and guard fixtures without claiming tests. If accepted, run only focused undemonstrated checks under `/run/lock/hosted-v1-heavy.lock`, then create an Ilya-authored conventional commit with `Refs #252` and immediately push the accepted slice to the PR #252 branch.

Then review and integrate the completed Product contract and E2E checkpoints, remediate Owner and OpenCode from their binding rejected reviews, finish filesystem durability and Phase 10, and prove the built system on disposable sandbox projects only. Completion still requires four provider canaries, one mixed-team built-artifact E2E, all nine Core proof groups, Phase 10 crash/restart plus backup/restore plus rollback, final exact-head CI, exact artifact identities and an independent GO. PR #503 is already merged into the PR #252 line through merge commit `3e4907e8454128a91ebb4ce8868fb56be55871c5`; do not repeat that integration.

Never test agent commands, launch, provisioning, terminal runtime, task assignment or smoke flows on a real user project. Never stop foreign processes. Run at most one install, build or full-test workload per physical host and use the heavy lock. Verify author and committer as exactly `iliya <iliyazelenkog@gmail.com>` before every commit. Push each accepted slice immediately. Do not merge Hosted into legacy `main` or `dev` as part of this goal.
