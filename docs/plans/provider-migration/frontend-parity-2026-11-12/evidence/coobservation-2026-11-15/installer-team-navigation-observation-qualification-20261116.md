## Installer Team-card observation: resulting-source qualification — 16 November 2026

### Published scope and exact bytes

The documentation-only R1 is final blob `c01c4fe1926487a1d6489345c70dce4ec57fd062`, published in `5e604214ab04da67125eb28963b3da5347964c3a` and independently read back before source/test authoring. The reviewed two-file change was committed and immediately pushed as `2abcf83fddacbc1efedee83f9c1d203d12ed656e`, sole parent 5e604214, tree `0b3ff52f7d0bbfb8544e4a9295acb9f2f24ca103`. Complete root and independent published readbacks confirmed exactly two changed leaves among 9,809, with no mode/deletion or unrelated change.

| Path | Exact resulting blob | Physical lines / bytes | Reviewed change |
| --- | --- | ---: | --- |
| scripts/legacy-agent-host/desktop-ui-controls.ts | 1e94339df46ef3bb963555fc3cc7253055766a78 | 493 / 28,741 | +38/−1, only observeInput helper and wiring |
| scripts/legacy-agent-host/desktop-team-ui-smoke.test.ts | a78bfc7d0d656cd2a785aeb0a9bdd59a7262769e | 1,849 / 112,084 | 199 appended lines, complete cc200 prefix retained |

The full source review is blob `2160790d9e586b4b7f27c950aa98c740927886b0` (31,548 bytes; SHA256 06067db32664fc8c200adfd983f4b8dac6bf306b3d9dd6a28e219cc5fccabbcb). Its three unique source transformations reverse exactly to 2ea000d3, and the six final test corrections reverse exactly to the preceding 749d04 proposal. Unpublished ac12's object-only descriptor helper would have rejected the actual callable Zustand store; independent review corrected that before application. The final source reads the callable store's own getState with its original receiver and never invokes the hook. Initial 749d04 tests were also corrected before execution to require Teams/selected-A → B/B → A/A and explicit zero getter-invocation counters. No rejected proposal was applied or run.

### Actual local verification

Root ran the complete existing file once, followed by the five authorized scoped checks, on exact 2ab/0b3f. The pinned runtime was Node v24.21.0, executable SHA256 7fde7b8afa198da66257f42ee2001d874c7355631e6d1579a5fb5ef1f246df4c, with pnpm 11.22.0 and the original node-ci installation profile. NODE_OPTIONS, GOMAXPROCS and GOMEMLIMIT were absent. The checkout was clean before and after.

| Original command/scope | UTC interval or result |
| --- | --- |
| node --test scripts/legacy-agent-host/desktop-team-ui-smoke.test.ts | 02:00:11.594–02:00:17.554; 49 tests, 49 pass, zero fail/skip/cancel/todo |
| pnpm lint:fast:files, exactly the two changed paths | exit 0 |
| pnpm guard:source-file-size | exit 0; 5,020 production files, 141 frozen exceptions, original 800-line cap |
| pnpm guard:team-provisioning-architecture | exit 0; original architecture counts retained |
| git diff --check 5e604214 2abcf83f, exactly the two paths | exit 0, empty output |
| Original sorted-JSON-plus-LF source-closure check | exit 0; common 1,757 / Windows 1,798 / packaged 1,760; all selected paths exist |

All six commands completed by 02:00:21.214 UTC. The complete raw/manifest set is evidence tree `973688caf2734497dee00e4555b068a18e1df1d5`; manifest `60c14c34d594d09601415e45aa57631962438cc4`. The whole-file raw log is `770bcbe0852acd396c3f69aa8b5248db1cf63900`, 5,276 bytes, SHA256 ae566f6dbc56d96b80857bf6725e45b43f604d62261fd210b55ecf049916b0e3. The 49 cases comprise the preserved 44 original cases and five new actual-observer cases. No test-name filter, changed command, baseline missing-field run or manufactured historical RED was used.

There was no new build or compiled attempt. Root verified that the only non-documentation changes since the successful privacy-stage Host build at 67c7135f are the independently reviewed packaged CDP pin and these two TEST scripts. The compiled Host/controller/MCP dependency inputs remained exact. The already built privacy helper remained 8,412 bytes with SHA256 5cb7e0122cbd8d9ebb3e224c7d0b2322df349c1f0a8092fe7aeaf8a19fd2d581 before and after. This reuses the verified prerequisites; it does not reset any exhausted compiler/Main attempt.

### Meaning and remaining qualification

The five added tests invoke public observeInput and execute its actual renderer expression in a finite VM. They establish captured target identity across rename/removal, separate original before/microtask/timer samples, the callable-store receiver, stable and non-Team/null cases, closed malformed/unavailable states, six operand-accessor counters at zero, exact original listener/callback/action/clock counts, original 96/32 rings, a 3,101-byte maximal valid record and the 4,096-byte publication cap. An unrelated secret sentinel is absent. Serialization and diagnostic-write failures leave original callback work intact.

Only pointerdown, pointerup and click are eligible. Eligible non-card events retain null; other event types have no new field and add no target/store sampling. The existing callbacks, clocks, timeouts, owner checks and physical input actions remain unchanged. The additional projections are bounded observation work and have no timing-equivalence or causal-trace guarantee.

This qualifies the scoped observation implementation and its preserved local contracts. It does not explain or repair the historical 0660 Installer selection timeout or OpenCode geometry refusal, reproduce their missing history, qualify GUI/native/packaged behavior, establish complete cleanup, or transfer the old a3a9 170/59/41 and privacy 47 results to this source. The next separately reviewed frozen CI venue must retain all original resulting-source gates. Process fifteen-second readiness, packaged P08's separate ten-second Retry phase, Darwin P09 and full M16/platform/UI remain open.
