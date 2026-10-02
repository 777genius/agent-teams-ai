# Updater recovery desktop E2E

Run on an isolated Linux host with a display, or a desktop test machine:

```sh
pnpm build
xvfb-run -a node scripts/e2e/updater-recovery-desktop.mjs --output /tmp/updater-recovery-evidence
```

On a desktop with an existing display, omit `xvfb-run -a`. Dependencies are the
project's pinned Electron and existing `ws` dependency; no Playwright install is
needed. The harness requires built main/preload/renderer output. It does not
build or package the app itself.

On a disposable Linux host where Chromium's OS sandbox is unavailable, pass
`--no-sandbox` for this isolated test process. Root execution already uses that
flag. This does not alter production updater signature checks. Electron logs
are streamed to `desktop.log` during startup as well as preserved on failure.

The test creates a new `updater-recovery-desktop-e2e-*` sandbox under the system
temporary directory, isolates home/Claude/config/user-data paths, and launches
the real built app. A generated test-only main launcher sends `updater:status`
through `BrowserWindow.webContents`, records its receipt by real preload,
intercepts `shell.openExternal`, and controls updater IPC promises. The
production shell IPC handler, preload, store, and React controls stay active.
HTTP(S) requests from the test Electron session are blocked. No projects,
agent teams, provider sessions, or real installers are used.

Checks cover unknown-version generic failures, preserved original error text,
signature failure after a downloaded update, removal of stale restart actions,
the exact `https://agentteams.live/#download` action, and network retries for
both checking and downloading. A pending main IPC response makes immediate
error/progress reset observable. Unrelated periodic checking followed by a
no-update or same-version result must preserve recovery.

By default, `navigator.platform` is set to `MacIntel` only in the renderer to
verify macOS manual installation instructions on Linux CI. This is a UI fixture,
not proof of a native macOS installer. Pass `--renderer-platform Linux` to cover
the other installation copy. Actual host and fixture platforms are recorded.

`evidence.json`, screenshots, and `desktop.log` are written to `--output`.
The sandbox is retained for diagnosis; the harness stops only its own Electron
process. Delete the reported sandbox directory after examining evidence.
