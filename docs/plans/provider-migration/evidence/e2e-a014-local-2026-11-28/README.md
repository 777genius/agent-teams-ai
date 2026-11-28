# Current-source management TEST process E2E

The unchanged safe E2E passed against commit
`a01484ee4787698f7e3ce1d5b98a585edad54876`: 1/1 passed, zero skipped,
6.896 seconds for the test and 11.46 seconds total. The command exited zero.
The [manifest](manifest.json) records the exact command, toolchain, source and
compiled Host bindings, original local evidence hashes, and cleanup outcome.

This exercised Main IPC, captured Desktop ownership, the standalone Host, and
a separate TEST HTTP fixture process. The actual receipt recorded 46 events,
18 distinct fixture process IDs, and absence of every one of those IDs after
two shutdowns. Credential changes, OAuth code/automatic/cancel flows, model
checks/cancellation, and configured limits used controlled TEST inputs.

Raw captures remain local under the repository's evidence policy. The manifest
preserves their hashes and sizes; the full receipt and log also remain in the
current workspace. This does not qualify Electron controls, vendor OAuth, real
accounts/model services, native platform custody, or required current-head CI.

Before the passing run, normal sparse checkout and verified read-only Git
object reuse reduced this checkout's temporary-filesystem footprint from
840 MiB to 242 MiB. Source, compiled Host, assertions, and test deadline did
not change. Earlier interrupted attempts are not counted as test failures or
successes, and no specific operating-system kill cause is asserted.
