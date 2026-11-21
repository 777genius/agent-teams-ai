# Safe frontend shards and original OpenCode preflight

## Scope

Keep the existing native Claude/Codex gates unchanged and the completion PR in
Draft. The expanded finite Desktop workflow checks the exact PR head in eighteen
UI lanes and four parallel root Vitest shards. The separately declared native
OpenCode V2 management lane retains its existing scope.

The safe shards use the same two runtimes as the existing root Vitest CI job:
capture Node 24.21.0 in `AGENT_BACKEND_TEST_NODE` for exact Host tests, then select
the workspace runtime from `.node-version` (26.12.1) for the runner and SQLite
rebuild. Host pins are unchanged. They use frozen pnpm installation, lsof, and
original MCP/Host builds. They exclude
`*.live.test.*`, `*.live-e2e.test.*`, and `*.native.test.*`. Those exclusions are
unqualified, not passing native tests. Logs and JSON reports survive failures;
the original `Offline Host Desktop` aggregate requires all UI lanes and all four
shards to pass.

Root `test` and `test:ci` now build MCP before the existing Host prerequisite.
The original group-chat integration suite starts the compiled MCP entry, so a
clean checkout needs both builds. This matches the existing regular CI job.

## Why the original finite OpenCode launch was held

The retained c226 Desktop artifact came from job 132583043145, artifact
14131753864, ZIP SHA-256
`c038d5f01651cb3319cbbb1bdb9f5416a1472cfc23bd98d7ca7da4533b8d9037`.
Its screenshot and original receipt show the Launch button disabled after the
real captured Team model check. The durable `model.probe` record was held before
a successful native probe. Its Main readiness origin had no project provider,
the private XDG override made the global selection conflicted, and the fixture
used an uppercase provider identifier rejected by the existing selector.

The single-provider fixture now uses the original valid `test-provider` route,
writes a private project config from the same captured provider object used by
its peer, and pins the project's path and bytes. The declared key is the literal
`TEST-LOCALHOST-ONLY`; this is a finite credential-backed compatible route. It
does not qualify anonymous endpoint discovery, vendor authentication, or real
inference. The real Main capture still determines key presence and the real
Host still requires its original model probe.

The finite peer also returns the resolved native model API metadata and provider
options required by the original Host route check. Runtime MCP policy comes
from executing the exact bundled `OpenCodeMcpPolicyPlugin` config hook, with its
compiled bytes pinned in the fixture. No readiness result or policy nonce is
inserted into Host state by the harness.

## Local verification boundary

The original `DesktopBackendFeature.prepareCapturedModels` was executed under
plain Node with a fresh private TEST fixture. An import-only Electron shim fails
and counts every attempted Electron API access; its count stayed zero. The
result was ready, and the original durable probe was completed, successful, and
released. Main recorded the lowercase project provider and configured TEST key.
The peer received exactly the ordinary model-check prompt and exited normally;
no Team Runtime session was allocated. Original Host child exit and peer PID
absence were observed. This is Main-to-Host protocol evidence, not GUI evidence.

The initial local full-safe Vitest sweep is feedback evidence: its MCP/SQLite
prerequisites and source changed during the long run. Its failures must be
re-run after that transition. The four CI shards independently test one frozen
published head; the local sweep must not be presented as that stronger claim.

That interrupted sweep reported 1,982 files: 1,960 passed, 19 failed and three
skipped; 165 of the current 2,147-file safe inventory had no completion report.
After the prerequisite fixes, a bounded rerun of the 19 failed files plus the
native-crash file still reproduced a Node 24.21.0 cleanup abort in SQLite. The
upstream [24.21.0 cleanup implementation](https://github.com/nodejs/node/blob/v24.21.0/src/api/hooks.cc)
requires a current Environment in `RemoveEnvironmentCleanupHook`; the
[24.22.0 implementation](https://github.com/nodejs/node/blob/v24.22.0/src/api/hooks.cc)
uses the retained cleanup registry. The workspace's existing
[26.12.1 implementation](https://github.com/nodejs/node/blob/v26.12.1/src/api/hooks.cc)
also handles a missing current context. No dependency, test timeout or Host
runtime pin was changed to address that runner failure.

With the same two SQLite binaries and an explicit Node 24.21.0 Host capture,
changing only the local runner to the available Node 24.22.1 removed that abort.
Seventeen files passed; three existing Review worker fixtures then failed while
the intermediate `tsx` CLI tried to open a Unix socket forbidden by this local
environment. They now start the same original workers with Node `--import tsx`.
Worker arguments, real crash points, lease/recovery assertions and deadlines are
unchanged. All 30 focused tests passed, followed by the complete bounded set:
**20 files and 421 tests passed, zero skipped, exit zero**. These are recovered
constituent checks, not a completed full-suite or Electron result.

The final eight-file Desktop Node prerequisite passed all 60 tests without
skips, and the complete Host Desktop scripts TypeScript project passed. The
changed-file fast lint found four missing global declarations in the finite
peer; explicit Node timer imports and `globalThis.structuredClone` fixed those
without changing protocol behavior. Three pre-existing warnings remain in the
Desktop observation/smoke scripts.

The interrupted-schedule fixture now supplies the required original run start
timestamp. Its four real Croner/Main/Host tests pass without provider allocation.
Workflow YAML, thirty shell blocks, four embedded JavaScript blocks, all eighteen
unique UI lanes, and the four-shard aggregate were checked locally. Full Desktop
and platform acceptance still require the original CI receipts and screenshots.

## Requested Quit observation

The c226 Review artifact 14132049710 (ZIP SHA-256
`77d22a734f717d5df86665a6199b6f5697ea62efa09024b7f91073511896a2ec`)
completed the original Keep/Reject, disk changes, Undo/Redo and renderer reload.
Its overall receipt correctly remained incomplete: cleanup observed the dev
wrapper as `[MainThread] <defunct>` before its original child exit callback, with
wrapper descendants still listed. No new signal authority follows from that
observation.

After an already requested Quit, cleanup now uses the same existing three-second
observation budget to let that exact ChildProcess report its exit before the
process census. Original command identity, process-group, signal and full-absence
checks are unchanged. A real detached TEST Node child with one bounded graceful
close request reproduced the premature signal attempt before the change; the
same regression then passed with natural exit zero and no harness signal. All
twenty-five existing process-observation tests also passed. This does not
retroactively qualify the incomplete CI receipt.

## Original member detail target

The c226 Claude UI artifact 14133317027 (ZIP SHA-256
`c6edb306fe57f6ffb1952a3e3d223d4d347d17853deb42c6d889808115b4210b`)
completed launch, streaming, permission/question responses, compact, skill,
review and cost actions before the member-detail target read timed out. No
member-detail hover or click was attempted. The retained screenshot shows the
original Alice member card; the driver searched all button-role divs, including
conversation/activity headers that can contain the same name. The artifact does
not contain a measured candidate count. The selector now uses the existing
MemberCard `group/member` class token and still requires one exact name, visible
bounds, the original pointer target and no nested button. Logs/Stats assertions,
the physical click and original deadline are unchanged; new-head UI proof is
still required.
