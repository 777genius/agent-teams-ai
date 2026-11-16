# R1 — explicit never-returning getter in the passive navigation TEST fixture (2026-11-16)

## 1. Status and exact scope

This is a documentation-only proposal for one TEST-source correction. It authorizes no source postimage before root publishes the complete R1 on the own fix branch and an independent reviewer completes published text/tree/preimage readback. Root alone may subsequently apply and immediately push the independently reviewed one-line postimage under a fresh own-branch lease. No canonical, primary, frozen CI or provider ref movement, CI dispatch/rerun/cancellation, PR metadata change, new venue, dependency install, build, compiler invocation or vendor command is authorized.

The current known own parent is 78baa7668cc67c96dc1629863b38c1cded2e8ed8 / tree 2fad0e50931a0975cf71a6e529892b7396f0e6c6. It already preserves the reviewed Management receipt correction, Teams diagnostic R1 and Windows diagnostic R1. A later reviewed parent may be retained only after a fresh complete-tree comparison proves the exact target preimage and all unrelated source remain intact. Neither concurrent diagnostic proposal is implementation authority for this correction.

The sole executable path is scripts/legacy-agent-host/desktop-team-ui-smoke.test.ts, exact current preimage 44cf93706a5b92be4296119810c7c07264cb4ccd: 1,960 physical lines, 119,240 UTF-8 bytes, SHA-256 c8c37d98de5700d2fa21afc46b61108235bb80f2c45505b73907ac33764b9a10. The bound is exactly one unique literal replacement, +1 / -1 physical diff line, zero net lines and seven added ASCII bytes. No import, test name, test count, helper, assertion text, fixture value, callback, timing, production reader, renderer, workflow or compiler configuration is added or changed.

## 2. Actual original compiler failure and evidence limits

The original frozen PR1211 packaged run 43790825796, attempt 1, event pull_request, uses source 2abcf83fddacbc1efedee83f9c1d203d12ed656e / tree 0b3ff52f7d0bbfb8544e4a9295acb9f2f24ca103. Its Darwin ARM job 133068178223 started at 2026-11-16T03:15:47Z and completed FAILURE at 03:17:56Z. The explicit platform checkout and staged-inputs sourceHead both bind 2ab. The separate classifier used refs/pull/1211/merge / 441e76ffe1cc5e288645877e15b312caf7b8c109; its full-scope decision is not substituted for the platform checkout.

The first compiler failure is in original step 25, “Typecheck and test packaged Host capture boundaries”. The exact unchanged command was:
~~~text
node node_modules/@typescript/native/bin/tsc -p tsconfig.legacy-agent-host-scripts.json
~~~
At 03:17:53.031310Z the full raw reports scripts/legacy-agent-host/desktop-team-ui-smoke.test.ts(1760,82): TS2378, “A 'get' accessor must return a value.” The process exits 1 at 03:17:53.034334Z. This is the sole TS diagnostic in that retained platform log. Prior app-build and candidate-staging steps succeeded. The later Node command listed in step 25 was not reached after the compiler failure under the original fail-fast shell; unsigned packaging and subsequent packaged smoke/native/GUI/relaunch steps are API SKIPPED. Neither successful staging nor an uploaded artifact qualifies those unexecuted assertions.

The original full six-payload evidence tree is 15c66417865c358f24ffc0333200e6884d1d1a8b. Its manifest is adfddf8c45f948c95a80e2d5a88d45c6a6aea814. The full platform raw is 371606d4fcfa2645220bed83a07dcdb75d017f38, 116,006 bytes, SHA-256 a429a97ec77d5387f562c927a209d593ccc6f701cfff60c28ab98a1178b3c6df. The full classifier raw is 4f2febfefe005bd2f20e61cd5af3bf0e86c013bb, 119,556 bytes, SHA-256 492c30ebb6c50fbb41ed9085c8876b096d55bb86fc2d71d1307f9e917d86c6be. Original run/jobs/artifact API blobs are a501a3aa3ab5a43d3e1f44e9d9f0bd92eb63ddd1, 566621ee41ad1366ffbc2474c293752ca90cfe07 and 12b2c7eaeff09a94f1febedcd4b4a4a9fd1fa65e. All five payload byte counts, SHA-256s and Git blob identities were independently recomputed against the complete manifest. The run snapshot still reports queued/null while the direct platform job is terminal FAILURE; no aggregate conclusion is inferred.

The original upload/API artifact is 14194563875, 345,083 bytes, SHA-256 cefe5200a68e7cb8fb2417f7ed68e73ded1bdcaac2f12aca8ccebde4e341a917. This proposal relies on the retained full raw/API/source join and makes no child ZIP-content verification claim. The separately triggered edited-metadata run 43792074232 is not substituted.

Frozen test blob a78bfc7d0d656cd2a785aeb0a9bdd59a7262769e has the failing line at 1760. Current Management test blob 44cf has the identical complete line at 1762 because the intervening accepted Management additions introduced two earlier import lines. The evidence manifest's “sameLineInBoth” is an identical-line-text observation, not a claim that the physical line number remains 1760. The complete 49-case passive-navigation local runtime result on 2ab and the later 53-case Management GREEN on bfdaf remain valid scoped runtime evidence; neither established this original whole compiler result.

## 3. Exact correction and preserved negative oracle

The unique preimage fragment is:
~~~ts
get teamName() { assert.fail('non-Team metadata is not read'); }
~~~
The only authorized replacement is:
~~~ts
get teamName() { return assert.fail('non-Team metadata is not read'); }
~~~
The surrounding exact line remains:
~~~ts
  pane.activeTabId = 'tab-A'; pane.tabs = [{ id: 'tab-A', type: 'dashboard', get teamName() { return assert.fail('non-Team metadata is not read'); } }];
~~~

This is an explicit return expression whose operand is the same original never-returning assertion. If the diagnostic incorrectly reads this non-Team metadata, the getter still invokes the same assert.fail once with the identical message and throws; it gains no normal return value. If the diagnostic correctly avoids the getter, neither form executes. The same dashboard tab, active-tab transition, original g.emit()/g.flush(), expected available/other/null navigation facts and all remaining negative controls are retained. The correction does not replace the accessor with data, remove the accessor, add a fallback, weaken the assertion, swallow an exception or make diagnostic metadata readable.

The language/compiler rationale is that the existing getter has no explicit return statement even though its sole expression calls a never-returning function. Expressing that same call as return supplies the accessor's return form. This is a source-supported minimal correction to the observed TS2378; resulting-source compiler PASS remains unclaimed until an original compiler gate actually executes that source.

All 53 current test cases and their complete bodies are retained except for this one keyword at the existing getter. The full current 44cf body, including all original 49 and four Management cases, must reconstruct byte-for-byte by the unique inverse replacement. No new regression or manufactured runtime RED is needed for a syntax/type-only correction already anchored to an actual compiler failure.

## 4. Publication and bounded verification

After this R1 is published and independently read back, author only the one-file immutable proposal. Provide its full decoded bytes, UTF-8 size, SHA-256 and Git blob identity, exact +1/-1 diff, final 1,960-line count and the unique forward/inverse journal. Verify the old fragment occurs exactly once, the new fragment did not already occur at that target, and applying the inverse restores complete 44cf. The expected seven-byte increase is an authored-scope bound, not an already created postimage or a typecheck result.

Independent R2 must verify both source semantics and complete recursive-tree inventory: only the stated TEST path changes, with no mode/deletion/unlisted delta. Root may then compose against the fresh exact current parent, commit and immediately push on the existing own branch, followed by independent full published readback. All frozen PR1211 refs, useful original jobs and the accepted Management reader 342fab2bf377b7ca6acd6dbd180a946382c00c1a remain intact.

The only permitted local checks after published readback are one scoped original fast-lint invocation for this changed TEST path and one scoped git diff --check for the one-line source commit. Use the already captured toolchain and unchanged lint configuration; record their exact commands, source/tree, raw logs and exits. Do not add a compile, build, dependency refresh, source-size/closure rerun, the 53-case runtime file, another test suite, a resource flag, a name selector or a retry. The change adds no line, source path, dependency or runtime behavior that would justify repeating those unchanged gates. A check failure must be retained and reviewed, not retried under this R1.

The original unchanged packaged scripts compiler is the resulting-source type qualification gate, in a separately reviewed future venue or other already authorized ordinary delivery. This R1 grants no new venue, head move, rerun or dispatch. Keep the current frozen-source TS2378 failure as historical evidence even if a later resulting-source run passes. The already exhausted local scripts/workspace/backend/Host-test compiler allowances are not renewed, and the separate original Updater quality job's successful compiler scope does not erase this packaged compiler failure or qualify an unexecuted postimage.

## 5. Completion boundary

Completion of this narrow correction means the exact one-line TEST postimage is reviewed and published, its two permitted local checks are reported honestly, and the original resulting-source compiler result is retained when it actually occurs. Before that compiler result, report only the source correction and scoped lint/diff result; do not declare all types or packaged execution qualified. There is no readiness, native custody, P09, 15-second Process, 10-second packaged Retry, Teams-navigation or ordinary Desktop functional repair in this change.

No source postimage, execution, commit or ref action has been performed by this child for this R1. No further implementation scope follows from this document.
