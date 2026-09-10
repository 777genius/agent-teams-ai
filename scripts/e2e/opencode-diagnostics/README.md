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
