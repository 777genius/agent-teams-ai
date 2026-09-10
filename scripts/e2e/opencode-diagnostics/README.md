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
