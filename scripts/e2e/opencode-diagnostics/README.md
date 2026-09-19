# Disposable diagnostics portability checkpoint

Base: `1ad3d79a6bc1b46b157e8d4956bfc6dee9dfaab3`. Only harness files change.

Dependency-free checks (no Electron startup):

```sh
node --check scripts/e2e/opencode-diagnostics-desktop.mjs
node --check scripts/e2e/opencode-diagnostics/platform.mjs
node --check scripts/e2e/opencode-diagnostics/fixture.cjs
node --check scripts/e2e/opencode-diagnostics/run.mjs
node --test scripts/e2e/opencode-diagnostics/platform.test.mjs
```

Later desktop verification, with dependencies and pnpm already provisioned:

Windows GitHub runner, PowerShell step:

```powershell
node scripts/e2e/opencode-diagnostics/run.mjs
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
```

Unix runner with Xvfb and lsof already provisioned:

```sh
xvfb-run -a node scripts/e2e/opencode-diagnostics/run.mjs
```

The runner seeds one disposable profile, starts `pnpm dev:mcp --noSandbox`,
waits for an owned renderer, inspects it, verifies version-exit/version-timeout/ready,
and stops the owned tree in finally. No native picker, browser mode, or teams.
It prints the sandbox artifact directory; preserve that directory as CI evidence.
Individual seed/start/inspect/verify/stop commands remain available. Start stays
in the foreground; use another process for inspect/verify/stop. Never reuse a
started sandbox. The manifest records absolute Node, fixture, CLI and profile
paths plus launcher PID and OS birth identity. A disposable app-managed OpenCode
current.json points at the shim, because production Windows PATH discovery
intentionally excludes non-native .cmd OpenCode launches. This uses existing
fixture storage and does not alter production runtime resolution. Clipboard and correlated real
app-log assertions remain in the original harness; selectors are unchanged.

Windows process/desktop behavior is **not verified on Linux**. Windows requires
Windows PowerShell, CIM Win32_Process CreationDate/ParentProcessId access,
Get-NetTCPConnection listener ownership access, and an interactive Electron
renderer with clipboard access. Native cmd shims support spaces and quoted
ampersands; paths containing percent, exclamation, caret, question mark, quote
or newlines are rejected. pnpm must already resolve on PATH. Unix retains
ps/lsof and requires /bin/sh. The inherited environment is allowlisted for
OS/build/display plumbing; provider secrets and configuration overrides are
removed, and home/config/data/cache/temp/userData and both runtime paths are
sandboxed. PATH remains available for build tools, with the fixture directory
first; start refuses OpenCode candidates on inherited PATH and common Unix
fallback directories without executing them. Use a clean CI runner without installed provider CLIs or shell startup
customizations. No runtime installation or download is part of this recipe.

Ownership checks fail closed on missing/reused launcher identities and foreign
listeners. Cleanup snapshots descendants and rechecks each birth identity before
individual signals; it never uses process-group kills or taskkill /T. A vanished
launcher causes refusal, rather than guessing ownership of orphan processes.
Like the retained Unix ps check, OS query plus signal has a small unavoidable
PID-check/signal race; Windows uses precise OS creation timestamps, Unix ps
lstart has second resolution. Port binding is checked before launch and actual
listener ancestry is checked before CDP HTTP and WebSocket access.

## Catalog extension (desktop catalog PR641)

The runner now retains the three version scenarios and then runs `delayed8s`,
`directory-error`, `models-four-errors`, `partial-success`, `catalog-retry`, and
`catalog-timeout` in that order. Sources are opencode, anthropic, google and
openrouter. Partial success retains the opencode model with three source errors;
retry requires four successful model responses and disappearance of the alert.
The delayed summary really sleeps eight seconds in the fixture subprocess. The
catalog timeout really exceeds the normal 30-second main command deadline.

`catalog.mjs` drives the existing dashboard's OpenCode re-check button via CDP,
uses its existing error formatter/copy button, reads the actual system clipboard,
and saves per-scenario UI text, loading/final/failure screenshots, subprocess
PID/timing/argument evidence, copied reports, and matching persistent main logs.
A separate normal preload API probe saves `*-ipc.json` with its own main report
IDs. **Those IPC probes are separate attempts**, not a claim that their IDs are
identical to the dashboard attempt. UI clipboard IDs correlate to UI main-log
records; IPC IDs correlate independently. No APIs or clipboard implementations
are replaced and no test React components are mounted. Only null project scope
is accepted by the catalog fixture; it refuses project paths and mutation flags.
Fixture `calls.ndjson` includes intentionally fake secret markers in raw fixture
responses; actual copied reports and persistent app logs must redact them.

Ownership failures additionally retain `ownership-failure.json`: manifest
launcher PID/birth, the owned tree before listener lookup, listener PIDs, and a
subsequent OS process snapshot. The latter is evidence only and cannot authorize
access after a failed check. The cause of the intermittent ancestry mismatch is
not established. No ownership predicate or kill scope has been relaxed.

Additional dependency-free worker verification:

```sh
node --check scripts/e2e/opencode-diagnostics/catalog.mjs
node --test scripts/e2e/opencode-diagnostics/platform.test.mjs scripts/e2e/opencode-diagnostics/catalog.test.mjs
```

External parent verification: run the existing `run.mjs` command above on each
supported desktop OS and preserve the printed sandbox root. This worker has not
run Electron, builds, installs, or heavy checks. Catalog UI selectors, timing,
clipboard behavior, Windows shim subprocess termination and end-to-end results
remain for the parent to verify. The dashboard must be expanded, in English, and
expose its normal OpenCode re-check control; unavailable controls fail explicitly.
The recipe retains `pnpm_config_verify_deps_before_run=false` to protect pinned
linked dependencies. An ancestry failure is a blocker to that desktop attempt;
inspect its snapshot instead of bypassing the guard.

## Windows startup cleanup recovery (separate scenario)

With dependencies already provisioned on a clean disposable Windows desktop runner,
from the repository root (PowerShell):

```powershell
$sandbox = (node scripts/e2e/opencode-diagnostics-desktop.mjs seed startup-cleanup).Trim()
if ($LASTEXITCODE -ne 0) { throw 'Cleanup seed failed' }
$driver = Start-Process -FilePath (Get-Command node).Source -PassThru -NoNewWindow `
  -ArgumentList @('scripts/e2e/opencode-diagnostics-desktop.mjs', 'start', "`"$sandbox`"") `
  -RedirectStandardOutput "$sandbox/launcher.stdout.log" `
  -RedirectStandardError "$sandbox/launcher.stderr.log"
try {
  $readyBy = (Get-Date).AddSeconds(60)
  do {
    node scripts/e2e/opencode-diagnostics-desktop.mjs inspect $sandbox
    if ($LASTEXITCODE -eq 0) { break }
    if ($driver.HasExited -or (Get-Date) -ge $readyBy) { throw 'Owned renderer unavailable' }
    Start-Sleep -Milliseconds 250
  } while ($true)
  node scripts/e2e/opencode-diagnostics-desktop.mjs verify $sandbox
  if ($LASTEXITCODE -ne 0) { throw 'Cleanup verification failed' }
} finally {
  node scripts/e2e/opencode-diagnostics-desktop.mjs stop $sandbox
  Write-Output "Cleanup artifacts: $sandbox"
}
```

Do not run the general `run.mjs` catalog/version scenario sequence on this profile.
Seed selects cleanup before launch; it never changes catalog behavior mid-request.
The verifier uses the existing ownership-checked CDP driver and real Manage →
OpenCode settings controls. Supplemental concurrent existing preload retries are
recorded separately from the UI Retry click. Each synthetic cleanup subprocess
waits for its own request-ID release file, atomically publishes a strictly correlated
response, and journals accepted/response-written/normal exit. It never runs input
`cwd`, spawns a host, or kills a process. The production local scans/tail still run
on the disposable profile. The existing driver's final stop is limited to its owned
harness process tree.

`startup-cleanup-evidence.json` and `calls.ndjson` are the primary artifacts;
preserve the whole sandbox on failure too. A refusal fails the verifier. The total
verification limit is 360 seconds including Electron initialization and two cleanup
attempts; it never renews on polling. Each attempt's distinct 120-second admission
deadline is recorded separately. The harness limit is not a production cleanup SLA. No CDP call waits for a deliberately held retry: promise results
are polled externally. Both terminal UI transitions require the actual owner status
and at least the production eight-second tail after response publication.

Dependency-free checks:

```sh
node --test test/scripts/opencodeStartupCleanupFixture.test.mjs
node --check scripts/e2e/opencode-diagnostics/startup-cleanup.mjs
node --check scripts/e2e/opencode-diagnostics-desktop.mjs
```

Linux source/fixture tests do **not** qualify Windows Electron behavior. Parent CI
must establish Windows initialization, shim transport, selectors, IPC, tail drainage
and UI completion. This scenario submits **zero launches** and checks empty
team/task/session storage throughout recovery; it proves cleanup itself did not
initiate a launch. The stronger “rejected launch was never queued” invariant remains
with existing provisioning/gate unit tests. Native host discovery, taskkill drainage,
real host registry mutation and packaged-runtime qualification remain separate proof.

## Packaged Windows qualification (future binary execution required)

The fixture recipe above remains the default. The explicit packaged runner accepts
an **already unpacked** Windows desktop executable, not the NSIS Setup executable:

```powershell
node scripts/e2e/opencode-diagnostics/run-packaged.mjs --packaged-executable "C:\test-builds\win-unpacked\Agent Teams AI.exe" --runtime-setup app-install
```

Run on an isolated Windows desktop runner with the existing harness dependencies
(including `ws`) already available. No build, dependency installation or release
workflow is invoked by this recipe. This source-only worker has **not executed a
packaged binary**. The parent must run the command against the intended release
artifact and retain its printed sandbox directory before claiming packaged E2E.

The setup option explicitly enables only `electronAPI.openCodeRuntime.install()`
on the cold run if discovery reports a missing runtime. The current production
installer selects the registry's OpenCode platform package, verifies its package
integrity, and writes its normal managed manifest under the disposable userData.
It is not a pinned/offline installer. Without this option, a missing runtime fails
qualification; there is no binary-path, URL, cache import, credentials import or
fixture-manifest option. If release verification needs a pinned/offline OpenCode
version, the missing contract is an **app-supported version/package selection
API**: the current `install()` API accepts no version or artifact parameter. Do
not work around that by writing `current.json` or downloading a runtime yourself.
No setup command has been executed by this worker.

The runner creates HOME, USERPROFILE, APPDATA, LOCALAPPDATA, XDG config/data/cache/
state, temp, Claude root and Electron userData before starting the executable.
It retains that profile for exactly one cold and two warm attempts. Every attempt
has its own log, manifest snapshot, evidence and 1440×1000 screenshot. Cleanup
uses only manifest-owned PID/birth identities, including previously observed
reparented children. A surviving owned process, reused launcher, foreign port
listener or failed cleanup prevents the next run. Verification failures do not
qualify, even when their diagnostic capture succeeds. No agents, teams, terminals,
model execution probes, real projects or credential connections are launched.

Production resolver review behind the guard:

- `ClaudeBinaryResolver.ts` prefers `resources/runtime/claude-multimodel.exe` with
  no configured override. Packaged preflight requires that file and later matches
  the actual main API selection and its SHA-256 to it.
- `OpenCodeRuntimeInstallerService.ts` tries the managed manifest, then Windows
  PATH/NVM candidates. `cliPathMerge.ts` adds HOME/APPDATA and, when present,
  ProgramFiles candidates. `shellEnv.ts` skips Windows login-shell discovery.
  Packaged mode therefore forwards no inherited PATH, ProgramFiles, NVM, Node,
  shell or runtime overrides; its OS-only PATH is checked for installed runtime
  candidates before launch. Working directory is the new sandbox. Managed paths
  are checked by realpath before warm launch and against the main API result.
- `package.json` uses `asar`, unpacks `out/renderer`, and copies `resources/runtime`
  through `extraResources`; `docs/RELEASE.md` describes the Windows NSIS release
  packaging. The expected renderer URL is the virtual
  `resources/app.asar/out/renderer/index.html`, backed by the unpacked file.
  Arbitrary `file:` pages are refused. Before attaching, the harness checks port
  ownership, live PID/birth ancestry, the listener's actual executable path and
  the exact packaged renderer entrypoint. No release/publish workflow is run.

Evidence separates runtime discovery (`getStatus({providerStatusMode:'defer'})`),
selected bundled orchestrator execution (`--version`, isolated environment, 10s
subprocess bound, duration/exit/stdout/stderr/error retained even on failure),
OpenCode version (`openCodeRuntime.getStatus()` after invalidation; main's separate
30s version probe), and provider
summary (`getStatus({providerStatusMode:'full'})`). It records app executable,
app.asar, renderer and bundled orchestrator hashes, app version, selected runtime
paths/versions/SHA-256 and the app-generated OpenCode package integrity metadata.
Deferred discovery intentionally permits a null installedVersion: main skips the
version probe unless cached evidence is recoverable. Only the separate selected
binary execution qualifies orchestrator version health (zero exit, nonempty stdout).
Cold optional app installation follows OpenCode missing-status discovery and
precedes its recheck, full summary, and measured UI refresh.

The UI must expose the normal English OpenCode re-check button. Qualification
requires its loading-to-ready transition **and the actual measured UI promise
completion payloads**, with fresh model pages, correct sources and complete
pagination. Later independent fresh API models cannot qualify unknown UI freshness.

The dashboard's public DOM retains model badges during warm refreshes and its
aggregate props discard per-page freshness. A narrow test-only preload observer
is therefore installed at the existing public `contextBridge.exposeInMainWorld`
boundary using a CDP source breakpoint and one renderer reload. It observes only
`loadProviderDirectory` and `loadModels` while the measured refresh is armed;
wrappers call the original method once and return the identical promise. A side
branch snapshots completions without changing returned data or failures. No
packaged files, immutable exposed APIs, stores or credentials are replaced. The
breakpoint is removed immediately after installation, observation is disarmed
before independent API probes, and records are bounded. Unsupported preload
layout/CDP observation fails closed. This reload is part of each run and must be
accounted for when interpreting cold startup evidence; it does not restart the app.

Read-only React inspection remains necessary for the complete rendered dashboard
inventory and completion transition: the DOM has no stable signal carrying both,
and warm badges can hide loading. Lookup discovers the FiberRoot and traverses
only `FiberRoot.current` child/sibling links, including shared bailout subtrees;
return ancestry is used only to locate roots, never to choose an alternate.

Separate normal main IPC directory/model requests use `refresh:true` and
corroborate the measured UI inventory. Directory and model pagination follows at
most 20 pages, rejecting duplicate IDs, repeated/mismatched cursors, changing
totals, truncation, errors, and stale/unknown model pages. Successful empty
inventories in clean authless profiles are permitted but explicitly recorded as
`transport-only`, with `providerQualified:false` in both run evidence and the
aggregate runner result. Nonempty directories must still contain the OpenCode
source; all measured connected sources must match. Fresh individual pages and
`provider-inventory` evidence do not establish a shared generation, authenticated
provider execution, or launch authority. No retained UI success qualifies a run.

Managed runtime directories are created/validated with ancestor-aware realpath
containment before every app launch, even without `current.json`; escaping
junctions are rejected before directory creation or optional app installation.

On failure the harness attempts the actual diagnostic Copy control, reads the
clipboard and matches report IDs against disposable `logs/app-errors.ndjson`.
Absent controls, unavailable clipboard access or missing correlation are recorded
as capture limitations, never successful qualification. Startup/ownership failures
may prevent safe renderer access entirely; only launch/ownership logs are then
available. `packaged-runs.json` is successful only when all three runs qualify and
all three owned cleanups succeed. Keep the disposable profile for review; the
runner does not broadly remove processes or directories.

Lightweight source verification only:

```sh
node --test scripts/e2e/opencode-diagnostics/platform.test.mjs scripts/e2e/opencode-diagnostics/catalog.test.mjs scripts/e2e/opencode-diagnostics/packaged.test.mjs
node --check scripts/e2e/opencode-diagnostics-desktop.mjs
node --check scripts/e2e/opencode-diagnostics/run-packaged.mjs
```

Actual Windows executable startup, runtime installation, preload observer support,
fresh UI/IPC results, clipboard permissions, process cleanup and cold/warm behavior
remain unverified until the parent executes the packaged runner. No heavy pnpm
checks are appropriate on this disk-constrained worker.
