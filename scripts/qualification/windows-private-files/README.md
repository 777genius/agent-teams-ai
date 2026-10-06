# Native Windows filesystem qualification

Install this packet in the canonical repository layout:

- Nine source files under scripts/qualification/windows-private-files: README.md, package.json, pnpm-lock.yaml, tsconfig.json, run.mts, native.test.ts, snapshot-manifest.json, fixtures/privateFiles.ts and fixtures/windowsPrivateAcl.ts.
- The separate workflow at .github/workflows/windows-private-file-qualification.yml.

Publish only those named files. Reviewer custody files, private reports and archive identifiers are excluded. Push the test/windows-private-file-qualification branch to trigger the workflow. It copies only the nine source files into a fresh RUNNER_TEMP directory so parent workspace configuration cannot affect the standalone frozen install.

The workflow uses pinned Node 24.21.0 and pnpm 11.22.0. From a standalone copy of the nine source files, run pnpm install --frozen-lockfile --ignore-scripts, pnpm typecheck and pnpm qualify. Ignore-scripts applies only to this compiler fixture, not the product installation policy.

The test creates new directories under the runner home, uses authentic native Windows identity and ACL calls, and cleans only its own fixtures. It checks first publication, replacement, temporary-file ACL rejection, foreign grants and filesystem links. The unmodified profile inheritance test reports principal categories and keeps owner/privacy failures visible. Elevated Windows processes may create Administrators-owned files. Only the current user or builtin Administrators may own a fixture, and a direct current-user Allow plus the existing restricted ACL is still required. Foreign owners or grants remain rejected. It does not repair the default profile to force a pass. No service, real profile, account or provider is used.

Non-Windows execution skips native ACL tests and is not Windows success. Source snapshots are verified against snapshot-manifest.json before compilation.
