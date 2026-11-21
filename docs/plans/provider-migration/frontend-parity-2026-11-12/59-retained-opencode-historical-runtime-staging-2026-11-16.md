# 59. Preserve the historical retained OpenCode runtime in separate TEST staging

## Selection and original evidence

This plan selects a preparation-only repair for the existing retained OpenCode coexistence job. It preserves P10 §35: the old literal-bob runtime **0.0.158** coexistence and Stop-isolation journey remains distinct from genuine donor4a **0.0.160** Task, Changes and cold-history evidence. No business action, assertion, deadline or qualification is replaced.

The original failure belongs to app `3be1fb3ec43d5682aa2ca77a6af62e6fa27b597b`, run `43933487486`, job `133563800019`. The original log is 133214 bytes, SHA256 `c636182ce804d96313b939a957a5b8f24061f26ad8eff988ab6fdc7b1b210ac6`. It records successful checksum-verified staging of current runtime 0.0.160, then rejects its COMMIT `e13edcd3d4ffbecc0272ae30195cc6b15b710ee7` against the preserved old-row expectation `f5c69c2e9024ffc36a5db5eafe30f53539b52f62`. The first comparison against the current lock passes. This is before the original coexistence native/UI command; later missing receipts do not establish additional business failures.

Target parent at preparation is `4900dcd71399b118b9dcc0a2e525280da9a06be0`. Root must verify the following three preimages against the actual publication parent and preserve unrelated incoming work. Publish and read back this selected plan before any source afterimage.

| Existing source path | Expected preimage | Current lines |
|---|---|---:|
| `.github/workflows/ci.yml` | `4e4554ec3330d0c06b0736e861348d7279511361` | 2927 |
| `scripts/legacy-agent-host/prepare-retained-opencode-coexistence.ts` | `9f9900c7f9166de2a14eaf840fd88d12ae49841d` | 379 |
| `scripts/legacy-agent-host/desktop-retained-opencode-coexistence.native.ts` | `a910209438b29f04ea4a30f28e69620d98802183` | 727 |

These are the complete source scope. No product, provider, lock, stager, helper, model, test, source-roster or generic runtime API is changed. The existing strict script project and five-file fast-lint list already cover both changed TypeScript files.

## Three independent input roots

| Role | Root | Runtime identity |
|---|---|---|
| Current Host V2 base, Bun and graph | Current checkout `resources/runtime` plus its existing graph directory | Current lock 0.0.160 / `e13edcd3d4ffbecc0272ae30195cc6b15b710ee7` |
| Historical retained fork | Current checkout `.runtime-download/TEST-retained-release-158/resources/runtime` | Historical lock 0.0.158 / `f5c69c2e9024ffc36a5db5eafe30f53539b52f62` |
| Original donor4a | Existing `.runtime-download/TEST-donor-4a/resources/runtime` | Donor lock 0.0.160 / `e13edcd3d4ffbecc0272ae30195cc6b15b710ee7` |

Add one closed job environment input, `OPENCODE_V1_V2_RETAINED_REPO=${{ github.workspace }}/.runtime-download/TEST-retained-release-158`. Both scripts canonicalize it and require exact equality with that location under the canonical current repository. It is not an arbitrary user-selected checkout or alternative policy. The selected fork must canonicalize to exactly that root's `resources/runtime/claude-multimodel`; its parent COMMIT/VERSION must therefore belong to that same payload. Missing, redirected or mismatching inputs refuse before the model/session/UI business allocation.

The historical app identity is the already selected original P10 base [1d0f97f55de566036c970eab4f36b84620afdb3f](https://github.com/777genius/agent-teams-ai/tree/1d0f97f55de566036c970eab4f36b84620afdb3f), tree `ec540290c86af9755c94e52ac795aeda8586a98f`. Require the exact canonical Git top-level, HEAD and tree; no tracked changes against HEAD and no nonignored untracked input files. Apply these existing Git-check patterns before and after historical staging/capture and through the runner's existing retained source guard. Normal ignored staging outputs remain allowed by that original checkout's `.gitignore`; no source file is rewritten to make a check pass.

## Exact historical release and staging contract

The independently selected historical [runtime.lock.json](https://github.com/777genius/agent-teams-ai/blob/1d0f97f55de566036c970eab4f36b84620afdb3f/runtime.lock.json) has blob `771bffacba378d277484712bc5cb7941223b6d2c` and SHA256 `1311acf34215a47950dd071a23669a69ed866d4825bcde5d21db41302a71d29d`. Retain all these closed values:

- Version `0.0.158`, CLI version `2.777.777`, source ref `v0.0.158`, release tag `runtime-v0.0.158`.
- Source repository `777genius/agent_teams_orchestrator`; release repository `777genius/agent_teams_orchestrator_binaries`.
- Linux asset `agent-teams-runtime-linux-x64-v0.0.158.tar.gz`, archive kind `tar.gz`, binary name `claude-multimodel`, archive SHA256 `4c106fcebab79de525aa7c9bb7636aa91fa43e76b4d567a00f98b2e6650ab29d`.
- Linux delivery source and staged COMMIT `f5c69c2e9024ffc36a5db5eafe30f53539b52f62`; staged VERSION `0.0.158`; existing retained binary SHA256 `b9b4c9f786238922cad49f46e5ac147b4e361b182bd250e5fbb47571571059cd`.

Use one additional `actions/checkout@v6` of that exact app commit into the fixed historical root, with `persist-credentials: false`. After the unchanged current V2 preparation and before the old-row verification, run the original `node scripts/stage-runtime.mjs --platform linux-x64` with the historical checkout as its working directory. Keep the existing pinned Node 24.21.0 and existing release credentials. No historical workspace dependency installation, Host build or Electron build is added.

The historical stager is byte-identical to current: blob `fb06c3470b93df96ec0859536f135191616db093`, SHA256 `7ee8a9036562728a66d5a1dcd3ce7c97abf75cabeb97092eb9b87171ed2e29be`. It derives both lock and output from its own checkout, verifies the archive checksum and original graph-free base inventory, then stages only that checkout's resources. The immutable original source tree supplies its complete local import closure: `scripts/lib/{github-release-download-error.mjs,runtime-archive-checksum.mjs,runtime-payload-cache.mjs,opencode-v2-base-inventory.mts,runtime-archive-extraction.mts,runtime-bootstrap-diagnostics.mts,runtime-windows-zip-extraction.mts,runtime-payload-inventory.mts}`, plus `src/features/opencode-runtime-installer/{core/domain/v2Delivery.ts,main/infrastructure/runtimeZip.ts}`. Those files import local source and Node builtins; no new dependency resolver or copied staging implementation is needed. This is a source finding, not an execution claim.

The official published 0.0.158 release still lists Linux asset 723801865 with the same archive digest. No archive bytes were downloaded for R1, and API metadata is not substituted for the original stager's byte verification.

## Changes at the three existing consumers

1. **Workflow:** keep current staging and `prepare-opencode-v2-native.ts` unchanged, apart from correcting the misleading current-step label if needed. Add the isolated immutable checkout/staging and its source checks. Point the existing old-row lock/COMMIT verification to the historical working directory and preserve its literal `f5` expectation. Keep the current job selector, helper checkout `f5`, donor4a checkout/helper/build, original commands, budgets and artifact paths.
2. **Input preparation:** change only the normal coexistence branch that currently reads current `runtime.lock.json` and current runtime at lines 333–340. Bind the canonical historical root, its original app/lock/stager identity, original release bytes and existing helper source before accepting READY. Keep V1/V2 source-selection branches and donor capture behavior. Use existing `readJson`, `pin` and Git-check patterns. Record `appSource: { root, commit, tree, lockSha256, stageScriptSha256 }` and `archiveSha256` inside the existing `retainedRuntime` object, alongside its existing version/path/binary SHA/sourceCommit. All values are measured against the selected literals, not trusted merely because the environment or candidate receipt supplies them.
3. **Native runner:** after the existing source-selection early-return branch, use the same canonical historical root and lock instead of current lock. Check the existing input receipt's kind, READY status and current `sourceHead`, then join its retained runtime/source fields to those independently checked values. Carry the same added provenance inside `proof.inputs.retainedRuntime`. Extend the existing `verifyRetainedSource`/`retainedSourceGuard` with the original app HEAD/tree/clean-source check; retain all current-source checks and existing helper checks. Keep original release/helper hashes, helper build/validation, finite model, namespace, UI, inference, source-selector, Stop, Quit, cold and cleanup behavior.

The existing final inline workflow validator must join the added original-app fields and archive digest across preparation and runtime receipts and require the fixed historical root/commit/tree/lock/stager identity. It must retain every original business, helper, donor, no-replay and cleanup assertion. The original input-receipt read can be reused at its existing validation site; no new collector, generic source registry or parallel receipt framework is introduced.

The source-built retained helper remains selected from `f5` in `.runtime-download/TEST-retained-runtime-source`, with the original stock build and validator, using the already selected Bun. It remains `EXACT_RELEASE_SOURCE_BUILD` and `publishedRuntimeComplete:false`. The separate donor4a `4a0e06277fe216d9f82dbbede362668fe46622ee`, tree `4bb456a5b35b6fca0e795bc8b19a13f5f1f6defd`, runtime/helper `e13`, and all B2 Task/Changes evidence remain unchanged. Current V2 base/graph inputs continue to bind the current 0.0.160 lock.

## Verification, budgets and acceptance limits

Retain the existing `pnpm typecheck:legacy-host-scripts`, unchanged ordered five-operand `pnpm lint:fast:files --`, original model contract test, complete original coexistence native command, both source-selection commands and their original receipt validators. No new executable fixture or mirrored implementation test is added for this source/input repair. Independent source R2 must check the three exact diffs, canonical-root/source binding, wrong/missing/redirected-input refusals, preservation of every old assertion and the source-selection early return before this branch.

The original 900000ms test timeout and 30-minute job timeout remain. Added checkout/checksum-verified staging consumes those existing budgets; it does not pre-approve a duration increase. Expected implementation growth is approximately 25–45 workflow lines, 25–45 preparation lines (379 to at most 424) and 30–55 runner lines (727 to at most 782). Both TypeScript files must remain below 800 physical lines without line compression, formatting tricks or an exception. The actual cut must disclose its counts and receive R2 before publication.

This plan authorizes only inert source preparation after its publication/readback, followed by normal reviewed CI. It adds no native invocation, no genuine Claude/Codex execution or discovery, no local project execution, no retry, no product default activation, no Ready transition and no main/release/Stage2 action. Existing original OpenCode-only test semantics remain. Real same-head native coexistence, both Stop controls, donor B2 Task/Changes, cold no-replay, source-selection and physical cleanup evidence are still required; the original pre-business failure qualifies none of them.

The source-bound R1 packet has 22 exact source bindings and 20 static/data checks, SHA256 `0be4b3ce1a296d0e0cc8a3f7127e59411d2341753986a080124a273af849829c`. Its original evidence and immutable public source references above support this preparation diagnosis. It claims no test/compiler/provider/GUI execution and does not change the separate Windows native first-input diagnosis or any other incomplete acceptance row.
