# Hosted Web Core v1 transfer checkpoint - 2026-09-22

Authority:
- Original handoff SHA256: 646eb537b4b115cbd327df6d13a9d31242aff4ec0ea01168a313be49c36b39b6
- Goal: .codex-preserved/hosted-v1-goal-2026-08-31.md
- Workers used service-tier default only.
- Commit identity: iliya <iliyazelenkog@gmail.com>.

## Product PR 252

Branch refactor/hosted-web-feature-boundaries is pushed at exact head
a57180016a6b3c82b02942cf40c19e3edd005d7e.

Accepted pushed commits:
- d3bc5f02ae5f9701cfd6a0deeef20c4abfbd9112 exact-head regression fixes
- f940961ac6e8a98582555fa77c094f9e800dd3b7 source-size ratchets
- 4e2b16f82a688bb37ef501e2edd21686588e9de3 host capability fixture alignment
- a57180016a6b3c82b02942cf40c19e3edd005d7e remaining main lint rules

Accepted type fixture patch SHA256:
ba99f29b964db44c0697b94f19bbf920a17a7c7d15225d68eba3b20c82f0d68f

Accepted final lint patch SHA256:
33d070e6312a66d610ebbe779754f939f8a02f268b8c188123527924f5cd88fb

At predecessor 4e2b16f82, validate, Hosted Core, Phase 6, Phase 8, team
lifecycle, renderer lint, feature lint, and Windows smoke passed. Main lint had
the seven errors addressed by 765891274. Generic test shards failed and need
evidence inspection. ReviewRouter failed from external OAuth control-plane
configuration.

## GitHub checkpoint branches

Product:
- checkpoint/hosted-v1-contract-r3840 at 68e93a64a07be20ec898210a1ce3ea564fb18c1a
  completed, review required; manifest 06e64e98d80dddce8b8313397bcd32143924d4e1761443ee0c4f7358df4aa92a
- checkpoint/hosted-v1-e2e-r3858 at eeabd1f5e7497ff1eb3d6a42ef70f6ec7d0146c1
  completed, review required; manifest a77f5566970950a8ae073b7b2791f0af3a80ed50cdb95adf9d87f02bb709c170
- checkpoint/hosted-v1-fs-r3850 at e4aa7b50e33cb0b5ddab0b65ef59cd16a834cbed
  interrupted and unreviewed; manifest f83b39ac8900afdf23166c2f14a44efb088fe16846fa39fc1e6cf6f21c13642e
- checkpoint/hosted-v1-phase10-r3856 at 0075cf32ca5cb64b4fd6db0d9d6231a7cb787e9d
  interrupted and unreviewed; manifest afea892838bd2c2eef82c3aba346acbf29798e5e451ba5749da98924939fc723

Owner:
- checkpoint/hosted-v1-owner-r3852 at 451fef2cf06c20366409ee15d1fb1e06a40c0a11
  rejected with 10 P1/P2 findings; evidence only
  manifest ae5e4d8612a4a643ac7e0487417e9aea49dbac77e60a8dfda8ff0ce955ee2a80

OpenCode:
- checkpoint/hosted-v1-opencode-r3855 at 6435377963a6722a0a197992b6c29ecdc4e2d9e5
  rejected with seven P2 findings; evidence only
  manifest 5ad599564a9c413d908dcc98058f3c7897af7bcb572ab4cc29e232f25350055e

## Accepted runtime evidence

Runtime r710: 18/18 scenarios.
Result SHA256: 5faa1dc2da296d3b4c6d29d2b00425bd0e036bfe30042eaf4c672f3580c8aedc
Evidence: /mnt/volume_ams3_1784742570542/pr252-runtime-r710-exact-evidence-review-r712-acceptance/

## Remaining scope

1. Inspect/remediate Product generic test shard failures.
2. Resolve/re-run exact-head ReviewRouter after external control-plane repair.
3. Review and integrate contract and E2E candidates.
4. Continue Owner and OpenCode remediation from rejected checkpoint evidence.
5. Complete FS durability and Phase 10.
6. Run four provider canaries on disposable projects.
7. Run mixed-team built-artifact E2E on a disposable project.
8. Run all nine Core proof groups once.
9. Run Phase 10 crash/restart, backup/restore, and rollback.
10. Obtain final exact-head CI and independent GO.

Never run agent runtime scenarios on real user projects.

Final follow-up:
- a57180016a6b3c82b02942cf40c19e3edd005d7e applies exact project import groups.
- Accepted patch SHA256 120113bedbc7782c85851e754673db262f8f085b79e87a1e231095b789b4077b.
- CI run 35723557181 on predecessor 765891274 showed four remaining import-sort errors only; this follow-up addresses exactly those four.
- CI run 35724512361 verified lint (main) SUCCESS on exact head a57180016a6b3c82b02942cf40c19e3edd005d7e. Other jobs were still running at the transfer snapshot; ReviewRouter remained an external control-plane failure.
- Exact-head CI run 35724512361: Hosted Core, Phase 6, main/renderer/features lint, team lifecycle, and Windows smoke passed. Phase 8 failed only in lifecycle-recovery controller restart: docker compose up --detach --wait --no-deps hosted-controller did not become healthy. The first two Phase 8 scenarios passed. Artifact ID 10693621571, zip SHA256 29266b87e8476864119d547c0e317bfb0e2e680496652d9c230b39da83d43252. Inspect artifact before deciding whether code or runner health caused it.
- The same exact-head run completed FAILURE. Test shard 1/2 job 106734861488 had 6 files / 55 tests fail: the dominant cluster is `Refusing to persist malformed launch state` in TeamLaunchStateStore during launch-matrix recovery, plus missing OpenCode permission publication. Test shard 2/2 job 106734861278 had 3 files / 48 tests fail: the same launch-state validation cluster plus stale Phase 0 renderer inventory evidence for `src/renderer/components/team/TeamDetailView.tsx`. Treat these as product/evidence regressions until a bounded exact-head remediation proves otherwise; do not rerun the full matrix blindly.

## Active exact-head remediation

- Job `pr252-ci-remed-r3880` is running on old host machine-id `93732118417e46618cefafc022c8b1db` in `/mnt/my_first_volume_ams3_1783285769353/pr252-product-ci-remed-r3880`, exact base `a57180016a6b3c82b02942cf40c19e3edd005d7e`.
- Worker profile: `gpt-5.6-terra`, effort `high`, service tier `default`, no fast mode. Scope is only the exact-head generic test regressions from CI jobs `106734861488` and `106734861278`; immutable logs are in the job root.
- Job root: `/root/.cache/subscription-runtime/pr252-ci-remed-r3880`; PID at start `2273736`. Poll this exact job before starting a replacement.
- Runtime `main.40` at `2d53ea63...` failed before provider start because its deployment lacks the `ajv` dependency. The worker was restarted with the latest functional installed build `main.39` at `587047d6e714ebf03609be084a06a59e57725fe6`; CLI SHA256 is still `7384296cfe3ec31cd9ac4f13d73ebd5058b99377c799050777a94eaa65f59f6d`. Preserve `launcher.runtime-failures.log` as deployment evidence.
- Fresh pool status found ten scheduler-eligible slots: `account-b,c,e,g,j,k,o,p,s,x`. `account-i` was tried first as required and entered a short inconclusive cooldown; the functional fallback list remains configured.
- Producer `pr252-ci-remed-r3880` completed a static candidate but could not install dependencies because worker network is disabled. Exact patch SHA256 `f074403eb5af17c8ed4dff0e8468ed7063954e8620ab76ed9972b4330043792e`; handoff manifest SHA256 `294294fcc7c8e67606f8dfed8a4e2d60cf24dfeab0eedffecc6d2f60a0e4a000`.
- The unreviewed candidate is preserved on GitHub branch `checkpoint/hosted-v1-ci-remed-r3880` at `2766628b3e354c6860630d97e2df427da5be5e99`, based directly on Product exact head. Do not merge it before review and focused executable verification.
- Independent review `pr252-ci-review-r3881` is running in the same clean committed workspace with `gpt-6-astra`, effort `low`, service tier `default`. Poll its exact job root before replacing it.
- Review `pr252-ci-review-r3881` REJECTED exact checkpoint `2766628b3` with three P2 groups: durable detached-removal recovery leaves/replays the public reservation incorrectly; ProviderLaunchStress proof scenarios require capabilities absent from generic CI; and two guard fixtures fail before reaching their intended invariant. The reviewer verified the first-pass schema/HTTP/approval/inventory fixes themselves and all 200 inventory hashes.
- Remediation `pr252-ci-remed-r3882` is running on the same workspace and exact checkpoint, using `gpt-5.6-terra` medium, service tier `default`. A matching-lockfile shared `node_modules` is linked for focused executable verification; every heavy command must use `/run/lock/hosted-v1-heavy.lock`. Poll this job before replacement.
- At 2026-09-22 13:38 UTC, old host `188.166.24.162` stopped completing the SSH banner while `pr252-ci-remed-r3882` was running focused tests under the heavy lock. Two independent fresh SSH connections still timed out at 13:47 UTC. Do not assume the worker or patch is lost and do not start a replacement until the host/workspace is checked. The last observed uncommitted incremental diff touched `src/main/utils/durablePathOperations.ts` and `test/main/services/team/ProviderLaunchStress.live-e2e.test.ts`; it was not yet frozen or pushed.
- New host `209.38.106.83` remained reachable but had only 958 MiB free on `/`, below the explicitly accepted 5 GiB working threshold, so no replacement heavy worker was started there.
- SSH recovered at 2026-09-22 13:57 UTC without using the DigitalOcean browser console. The host showed load `13.90/180.05/243.78`, CPU pressure `some avg10=46.90`, IO pressure `full avg60=10.81`, 330 MiB free RAM and fully used 4 GiB swap. The r3882 runtime process and tmux session had disappeared while progress remained stale/running, so this is an interrupted worker, not a terminal success.
- The surviving r3882 diff was frozen and pushed on `checkpoint/hosted-v1-ci-remed-r3880` at `1f58b78a3437195da0890c2c76b1c4e8eb8bd8bb`. Incremental patch SHA256 `572e77b835edabd4bc1c2e70b2136d21393a6c73daae0c7d922b70c92cacae40`; cumulative-from-Product patch SHA256 `425a4cc6614e106a939cf3cde642b42e23d09644f4246f89302ace2fac74ad73`. It is unreviewed and its focused test run did not produce terminal evidence.
