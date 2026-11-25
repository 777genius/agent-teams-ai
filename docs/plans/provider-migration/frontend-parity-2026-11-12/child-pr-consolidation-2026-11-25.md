# Migration child PR consolidation — 25 November 2026

This follow-up collects the remaining reviewed child changes in existing
[#1220](https://github.com/777genius/agent-teams-ai/pull/1220), based on
`776a38e5f665475d3a09e7c9abf23b30f10d46de`. It creates no new PR. Delivery remains
**#1220 → #1192 → #1186 → #982**; #982 remains open/Draft. This record does not
claim full CI, native-provider qualification, release, or Stage 2 activation.

## Retired historical PRs

The following closures are not reported as new merges. Original branches,
commits, reviews and workflow results remain historical evidence.

| PRs | Verified disposition |
| --- | --- |
| #1206, #1207, #1208, #1211, #1212, #1213, #1218, #1219, #1223, #1228 | Each exact head is an ancestor of `776a38`. All 127 original branch runs were terminal before retirement. |
| #1221 | Captured parent sentinel is owned centrally by `nativeGateContext`; the original alive-neighbor, exact parent EOF and clean-exit requirements remain. |
| #1222 | Post-evaluation deadline rejection and all ten original deadline regressions remain in the canonical Node test selection. |
| #1226 | Blank prompts are omitted by the parser. Omitted and undefined values are equivalent on the actual parsed-JSON readback path. Existing member-reveal and sentinel requirements remain. |
| #1227 | Rejected obsolete alternative, not integrated. Its copied token cannot satisfy the original authority identity check; it also weakens owner/live-metadata guards. The accepted owner-qualified clarification path remains. The old P1 review was not falsely resolved. |
| #1188 | Selectively integrated, not whole-head ancestry. The shared 25-path recovery merge and later source/test behavior are retained or superseded. Windows refusal/settlement fixes and strict private Claude checkpoint-source validation remain. |

The last five state-only closures preserved all 255 original branch run records
and created no new runs. Earlier retirement body edits unexpectedly emitted
18 metadata-only CI/package runs; those exact accidental runs were cancelled and
verified terminal. They are not qualification evidence. Original historical and
current-source runs were not manually cancelled by that cleanup.

## Remaining child content collected here

### #1187: startup admission and bounded refusal diagnostics

The existing account-login behavior is already retained in the working stack.
This follow-up preserves its two remaining unique test-harness changes:

- Native `codex-login-ui` waits for actual Main/UI readiness before binding or
  account reads, under the original captured absolute startup cutoff.
- The original closed `initialUnavailableTarget` projection records an already
  observed More-menu refusal. It adds no CDP read, request body, credential or
  unbounded diagnostic field.

The common readiness loop retains its owner checks before and after reads,
post-read cutoff rejection, retry cadence and bounded history. Other modes keep
their original behavior. The backend harness remains exactly 800 physical lines.

The independently reviewed four-file patch has SHA-256
`39a6db477e7545f0c1390f7961bafd1e7bc01986444dacea2b687e1d239e4c95`.
Six selected finite Node cases passed, with zero skips. Original TypeScript 7.0.2
options scoped to the four changed files and their imports passed. Changed-file
ESLint passed with only two existing, unchanged backend warnings. These results
do not qualify the entire test suite or native Electron/provider execution.

### #1105: preserve the audit without reviving deferred work

The two historical audit documents are retained with explicit date/status
notices. The current Stage 2 plan and its deferred status are preserved; unique
older audit material is retained in a dated appendix instead of replacing the
current plan with the superseded November 4 instruction.

The [November 10 owner decision](https://github.com/777genius/agent-teams-ai/pull/1105#issuecomment-6771443351)
keeps new-core Stage 2 work deferred and distinguishes it from OpenCode V2 in the
Stage 1 Host. Retaining these documents does not start S2.1–S2.4, replace owners,
migrate user data or change the default backend. The original pins, outcomes and
future-core admission criteria remain historical evidence.

## Optional Electron dependency correction

An optional `require('electron')` can enter the npm package's binary-provisioning
path before a caller's fallback catches an error. The correction checks actual
Electron Main runtime identity before optional Electron and default Sentry SDK
loads. Ordinary Node, run-as-Node, renderer and utility processes retain their
standalone fallbacks. A real Main process remains authoritative even when a
disabled fuse leaves `ELECTRON_RUN_AS_NODE` present in its environment.

Existing Unicode paths, explicit overrides, legacy-data migration, diagnostic
logging, notification injection and Sentry failure semantics are preserved.
Unavailable Electron packaging metadata is represented as unknown (`null`).
The MCP fixture models packaged Main explicitly and keeps the real standalone
Node/MCP handshake in a Node process. A hoisted Electron test fixture prevents
collection-time package provisioning; unexpected mandatory Electron API use is
an explicit test failure, including errors caught by production fallbacks.

The earlier 17-case behavioral contrast is retained as historical validation:
original production had nine passes and eight intended failures; the corrected
production passed all 17. The earlier four-suite attempt failed before collection
and is not reported as a pass.

The reviewed fixture correction and unchanged corrected production passed all
**140 tests in the four original suites**, with zero failures or skips: MCP 49,
Sentry 19, path decoding 55 and the optional-Electron boundary 17. This includes
the original real Node MCP bundle/stdio handshake. The run used existing Node
26.12.1 and Vitest, one worker, the original configuration/setup and original
test deadlines. All 2,443 copied input hashes remained unchanged; the owned
process group was empty at terminal. No Electron installer or native-provider
execution occurred. Output SHA-256:
`78a6a6ef959be225aa1a4b4648c0a0bde2c62a5e705128b42bb0cca75a42a7fc`.

After that run, the only test-file change reordered named imports from the same
`node:fs` module to satisfy the existing lint rule; executable bodies, fixtures,
assertions and all nine production files remain identical. The corrected import
line passed the original ESLint rule. Scoped TypeScript 7.0.2 passed with original
compiler options and the existing React ambient declaration supplied as an
explicit input. Earlier reduced-scope diagnostics and the initial lint failure
remain recorded; no full application typecheck is inferred from this scoped pass.

## Recovery and fresh regression verification

An execution-environment reset removed the temporary verification copies before
publication. The 18 implementation/test/document files other than the startup
regression and this record were recovered byte-for-byte from immutable preimages
and the reviewed changes. The new startup regression was reconstructed from
the original #1187 coverage and reviewed again; the old unpublished 20-file tree
is not claimed as the final tree.

The new startup test blob is
`cb61b81355e6d1eb911cfce58495b622a895d40e`, SHA-256
`7e95e08c4c2a9bb4c3a3855ed47fb5693a36e2de3c230a99782d9634e7ad4b73`.
It preserves both original diagnostics/readiness-only paths and adds native
absolute-cutoff, dispatch and bounded-projection regressions. All six selected
finite cases were rerun on Node 24.22.3: six passes, no failures or skips, exit 0.
The run took 5.36 seconds without intervention or remaining owned processes.
All 293 copied inputs, 279 import-closure paths and pinned dependencies remained
unchanged. Fresh output SHA-256:
`30f2ad1cc14f3adb0e939b46586e8b2b127b682e516391734660698a59c6b278`.

## Final local checks

The combined tree passes the original source-size, Team Provisioning architecture
and runtime-artifact guards. All 5,182 tracked production files were present for
the size check; the 800-line limit and 141 frozen legacy exceptions were unchanged.
The changed code passes the existing fast lint rules; only existing backend and
path-decoder warnings remain. All 11 relative links in the retained documentation
resolve. These local checks supplement the existing PR gates and do not replace
current-head CI, packaged or native qualification.

## Delivery boundary

Only finite TEST peers and the separately admitted isolated OpenCode scope are
authorized under the existing provider-execution restriction. Ready events on
#1220/#1192 and lower-stack synchronization can select genuine Claude/Codex
executables. The workflow guards, original deadlines and required checks remain
unchanged. Queued, skipped, cancelled and incomplete jobs are not success, and
earlier-source results do not qualify a later commit.
