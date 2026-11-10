# OpenCode error diagnostics

When an OpenCode `--version` probe fails, the onboarding error exposes a compact stage label and a Copy diagnostics button. Details expand to show the selected binary/source, elapsed time and timeout, exit code or signal, bounded stdout/stderr, platform and a report ID. The same ID appears in `app-errors.ndjson`.

The report is an opt-in support artifact. It retains binary paths (which can include a username), while removing credential-like values and URL credentials/query strings. It never intentionally collects environment variables, auth files, HTTP headers or response bodies. Clipboard failure exposes selectable text. A successful status retry removes the previous error.

Provider-management diagnostics also accept optional stage/timing/HTTP metadata from a compatible runtime. Older runtime responses remain supported. This app change does not upgrade the bundled runtime or claim to diagnose every catalog failure. Runtime startup and catalog HTTP collection, aggregated status errors, and the separately reported five-second Windows summary timeout need their own changes.

## Verification

Focused suites cover the CLI boundary, installer, report normalization and clipboard failure/stale completion. The isolated Linux Electron fixture verified nonzero exit, the actual 30-second timeout, real clipboard copying, log correlation and successful recovery.

The Unix-only desktop fixture can be run with:

```sh
node scripts/e2e/opencode-diagnostics-desktop.mjs seed
node scripts/e2e/opencode-diagnostics-desktop.mjs start <printed-sandbox-path>
node scripts/e2e/opencode-diagnostics-desktop.mjs verify <printed-sandbox-path>
node scripts/e2e/opencode-diagnostics-desktop.mjs stop <printed-sandbox-path>
```

Use only disposable profiles/projects. The start command refuses an occupied dev CDP port. The Unix harness requires `ps` and `lsof` and verifies the CDP listener belongs to the recorded launcher process tree before interacting with it. On a headless Linux host use Xvfb. The harness disables the Chromium sandbox for the test Electron process and must not load untrusted content. It does not launch teams or agents.

Set the sandbox's `scenario` file to `version-exit`, `version-timeout` or `ready` before verification. The clipboard assertion uses the isolated test display. Windows and macOS desktop qualification and full production-runtime HTTP desktop E2E have not been completed.
