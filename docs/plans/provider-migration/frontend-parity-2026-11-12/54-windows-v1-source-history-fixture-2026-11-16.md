# Plan 54 — complete the Windows V1 source-history fixture

## Selected scope

This is a Stage1 test-fixture correction within the original provider/Host migration and Windows source-history acceptance. Keep PR #1192 Draft, its existing base, and default-off behavior. This selection changes one existing test file at two fixture construction sites. It does not select Stage2, a release, a main merge, a new provider route, or a new production admission policy.

Publish this plan before constructing or publishing the source afterimage. Preserve every incoming branch change using an expected-SHA fast-forward update.

## Observed failure and source binding

The original Windows ARM64 process job [133504007033](https://github.com/777genius/agent-teams-ai/actions/runs/43925579157/job/133504007033) ran source `1ef2c16ae547129e6b6ab5c47e03caa6b3f169df`.

- Its canonical TypeScript Native 7.0.2 compile group and controller build completed under the original fail-fast shell.
- Node contracts reported 164 PASS / 0 FAIL / 3 SKIP; protocol tests reported 54 PASS.
- The retained Main/Host group reported 90 PASS and three failures in `capturedWindowsSourceHistory.test.ts`, each with `held / generation-change-unqualified`.
- The broker build and later native Node/Electron/provider/source A/B gates had not started. Compilation success is not their qualification.

The exact decoded official job log is 127279 bytes with SHA-256 `c62028d3749631d8bd85ee8ee4ee91d5627067c86429b6d540264f67964c218d`. Artifact `14256564100` is 11412 bytes with SHA-256 `5c8038fb12d6a3f95cd44ab12af2ee321b2714e8db45546a8ab0f7f5dc2192ac`. Independent artifact audit SHA-256: `7d550a64e27d583e627b6803eceb75d1d21f3d13b9d4e2b6322a991e3fbcffa9`.

Source preimage: `test/features/agent-backend/capturedWindowsSourceHistory.test.ts`, Git blob `dd54632d57813fcb142a1c88ca9ec801567d11ed`, SHA-256 `1d52700b35b5f8c36e795e686f818b6877c4d6807caad2f2617bdca2bb173508`, 25096 bytes / 336 lines. It is unchanged in the incoming source head `447a4945e329c8c3b63942c63af951f964e0a14a`.

The root-cause R1 packet has SHA-256 `4b8b9f3d2805a4e49e7018e5b4777dcda67c8e9b2add60e33e901865fc493793`. Production policy `runtimeSourceQualification.ts` remains Git blob `fb25a317426e009f7920f2270a7f72d7f384f462`.

## Cause and selected correction

The OpenCode fixture chooses CLI version `1.19.4` and an original V1 seed. Its published candidate currently has `nativeCli: { executable: next, version }`. The retained-original candidate independently constructs the same incomplete shape with `executable: original`.

The production guard correctly compares `candidate.nativeCli.generation` with `seed.nativeGeneration ?? 'v1'`. The fixture's missing value fails that comparison before the intended launch-environment assertions. The generic schema permits an absent generation because the existing Claude/Codex routes require that absence.

Add only the following conditional property to each of those two existing `nativeCli` object literals:

```ts
...(options.openCode ? { generation: 'v1' as const } : {})
```

Use the existing inline/continuation style without unrelated formatting. Keep two independently constructed objects; do not introduce a shared mutable alias or a new helper. Codex still receives no generation field. The existing Host native-identity fixture already uses this conditional V1 pattern.

Keep the current successful-receipt `nativeVersion`: it already equals the candidate CLI version. The existing publication helpers continue to calculate fingerprints and source-history revisions. Do not add a receipt generation field or replace these calculations with constants.

## Preservation and review

- Keep all nine existing test bodies, actions, positive and negative assertions, TEST inert-image behavior, and cleanup unchanged.
- Keep production qualification, source grants, receipts, source identity, environment matching, native custody, and provider contracts unchanged.
- Keep workflow selection, dependencies, source pins, execution budgets, and CI policies unchanged.
- Keep the original history reconstruction and cold Main paths; do not skip, loosen, or normalize their checks.
- Add no redundant field-only test: the three failing original scenarios already exercise this passage and their subsequent environment assertions.

Before publication, independently review the exact two-site diff, bind both file images, verify that every other tree leaf is preserved, and immediately push the reviewed source commit using the current branch head as the lease.

## Validation boundary

Local work is limited to inert source, diff, hash, and evidence inspection. Do not execute the project, compiler, tests, GUI, providers, or genuine Claude/Codex CLI locally. Continue through the original CI workflow using pnpm and the canonical TypeScript Native 7.0.2 configuration.

The resulting-head Windows process acceptance must run the unchanged source-history scenarios, including published V1 source/default with model-limit overlays, ordinary management reconstruction, and general coordination through cold Main. Their later assertions and subsequent broker/native gates remain unproven until those original gates actually complete. A source review, cancelled job, skipped gate, or success on an older source tuple does not close them.
