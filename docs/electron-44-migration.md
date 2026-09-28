# Electron 44 migration trial

Status: draft migration. Base: `origin/main` at `3f2b19e3b91b6d5ff3e26f0befb554930e0e1877`.
Target: latest stable Electron 44.4.5 (as checked 2026-09-27).

This PR upgrades the packaged desktop runtime independently of the Node 26
toolchain trial in #760. Electron 44.4.5 embeds Node 24.21.0; it does not make
the desktop process run Node 26. No release is published by this PR.

## Migration steps

1. Compare Electron's official [breaking changes](https://www.electronjs.org/docs/latest/breaking-changes)
   for 42, 43, and 44 with our main/preload/renderer APIs and package scripts.
   Pin Electron 44.4.5 and regenerate the lockfile with the project's pnpm.
2. Verify binary download/bootstrap after Electron 42's change away from an
   automatic postinstall download. The direct `install.js` entry still exists;
   honor `ELECTRON_INSTALL_PLATFORM` when repairing `path.txt`. Use a Node
   postinstall script so Windows also provisions the binary before first launch.
   Verify a clean frozen install and missing/partial binary recovery paths.
   A package-managed installation requires the executable and `dist/version`
   matching the Electron package version, including after repair. An explicit
   custom `ELECTRON_OVERRIDE_DIST_PATH` retains its executable-only contract.
3. Raise the macOS minimum from 12 to 13 because Electron 44 cannot run on
   macOS 12. Update the landing page and release metadata. `latest-mac.yml`
   must declare Darwin `minimumSystemVersion: 22.0.0` so installed macOS 12
   clients do not download an app they cannot launch.
   Resolve the floor from the verified release target's manifest, so recovery
   of an Electron 41 release retains Darwin 21 instead of inheriting moving
   main's Darwin 22 floor. Reject unknown floors before modifying release assets.
4. Rebuild and load `better-sqlite3`, `node-pty`, and `ssh2`'s optional
   `cpu-features` module for Electron 44's native ABI. Keep `node-abi` current
   enough to recognize Electron 44 and regenerate `cpu-features/buildcheck.gypi`
   before rebuild. Verify the actual packaged modules, not only install exit codes.
   Load and call `cpu-features` directly from packaged `ssh2` resolution:
   `ssh2` catches optional module errors and cannot prove its ABI compatibility.
   If its preparation fails during developer postinstall, still attempt the other
   native modules. Postinstall retains its tolerant native-failure policy; it is
   not rebuild evidence. The matrix's separate explicit rebuild must succeed.
5. Run typecheck, affected tests, build, and exact-head CI. Package and smoke
   macOS arm64/x64, Windows x64/arm64, and Linux x64 using isolated test
   profiles and new sandbox/test projects. Verify renderer startup, SQLite,
   PTY open/close, MCP handshake through the packaged Electron executable with
   `ELECTRON_RUN_AS_NODE=1`, and cleanup where supported. A handshake through the
   CI host's Node alone does not cover the runtime used by the packaged app. The packaged
   smoke matrix runs in `.github/workflows/electron-packaged-ci.yml`.
6. Review the final package bytes, native ABI, OS support, and platform logs.
   Keep #760 separate; after both PRs merge, run focused combined checks on
   their integrated head.

## Definition of done

- Exact Electron package/version and embedded Node are recorded from the built
  application; manifests, lockfile, installer code, and docs agree.
- All targeted native modules load in packaged apps; failed rebuilds are not
  masked as success. Record the matrix's explicit rebuild result independently
  of tolerant postinstall and fail the migration gate if that rebuild fails.
- Exact-head CI passes and packaged desktop smoke has evidence for every
  supported OS/arch. A missing platform is `NOT VERIFIED`, not a pass.
- The real updater consumer rejects the generated feed on Darwin 21 and accepts
  it on Darwin 22, using the manifest of the verified release SHA. This proves
  feed eligibility; it does not claim a physical macOS 12 upgrade was performed.
  Verify the published `latest-mac.yml` before release completion.
- The test-notification action reports success only after Electron's `show`
  event. `failed`, an early close, a thrown error, or no confirmation within
  five seconds return failure. Signed candidate delivery remains a release check.
- Any agent launch, provisioning, terminal runtime, or task assignment E2E
  uses only new sandbox/test projects. Never open a real user project.
- A report gives PASS/FAIL/NOT VERIFIED per platform, reproducible failures,
  remaining risks, and rollback. Draft status remains until the evidence is
  complete. ReviewRouter's current infrastructure failure is excluded by the
  owner's explicit decision, but all other checks still apply.

The official release notes are [42](https://www.electronjs.org/blog/electron-42-0),
[43](https://www.electronjs.org/blog/electron-43-0), and
[44](https://www.electronjs.org/blog/electron-44-0). Electron 44 removes
macOS 12 support and changes clipboard APIs; this app currently uses browser
`navigator.clipboard` in its renderer. Native module rebuilds and packaged
startup remain the highest-risk checks.

## Remaining release risks

| Risk                                               | Required evidence before release                                                 |
| -------------------------------------------------- | -------------------------------------------------------------------------------- |
| Native rebuild fails but `postinstall` continues   | Explicit rebuild and packaged SQLite/PTy checks pass on every target.            |
| macOS 12 auto-updates into an unsupported binary   | Check the generated updater feed against Darwin 21 and 22 before publication.    |
| macOS notification behavior changed in Electron 42 | Test delivery from a signed macOS candidate; an unsigned CI app cannot prove it. |
| Native folder picker defaults changed              | Check project import and folder selection UX on a packaged candidate.            |
| Linux window controls changed                      | Check custom decorations on the Linux packaged candidate.                        |

## Verification evidence

The [PR evidence table](https://github.com/777genius/agent-teams-ai/pull/761)
records current CI and packaged results with their exact commit SHA.
The first five-platform checkpoint (`ce35c0c`) passed SQLite/PTy, MCP and app
startup, but did not prove `cpu-features` because `ssh2` hid its failures.
The strengthened direct probe must pass on all five targets before that native
module is reported as verified.

The 2026-09-28 follow-up checks use the real pinned `electron-updater` 6.8.9
eligibility pipeline and parse generated YAML. Only the metadata transport,
app lifecycle and OS version are test inputs; no update is downloaded or installed.
Darwin 21 rejects a macOS 13 release, Darwin 22 accepts it, and Darwin 21 remains
eligible for a recovered macOS 12 release. Removing the feed floor makes the
first test fail; restoring the old hardcoded Darwin 22 makes recovery fail.
All 16 focused installer/promotion tests and typecheck pass locally. This is
consumer compatibility evidence, not a physical macOS 12 upgrade test.

Source audit also confirms the Claude-root picker already has an explicit
`defaultPath`; the project-folder picker without it now starts at Downloads
under Electron 43+. Linux Window Controls Overlay is not configured, so its
layout change is not an active integration dependency. Rounded corners and
signed macOS notification delivery still need candidate UI acceptance.

The deeper audit found two additional gaps in checkpoint `0561a6c`: the MCP
probe used CI host Node rather than the packaged runtime, and the notification
test returned success before any native acknowledgement. The MCP probe now
uses the packaged executable, like production. A broken executable that had
previously passed the synthetic handshake now fails the probe. Notification
result checks exercise delayed failure, acknowledgement, timeout, and cleanup;
they cannot establish physical notification delivery. The PR evidence table
records the checks for the final SHA containing these fixes.

An unavailable compiler for cached optional `cpu-features` also made preparation
throw before any other native rebuild was attempted. Postinstall now isolates
that failure and attempts PTY, SSH, and SQLite rebuilds, which can use available
prebuilt binaries. Strict Electron provisioning still fails on its own errors.

The next audit found that executable-only provisioning could accept a partial
extraction or a stale managed distribution after Electron's package postinstall
was removed. Managed installs now check the version marker before and after
repair. A missing-version regression fails before the fix; 13 installer tests
cover repair, failed repair, healthy marker recovery, and custom overrides.
The PR records the subsequent exact-head CI and package matrix results.

Rollback is a revert of this PR plus republication of the last verified
Electron 41 build if a release has already shipped. Do not overwrite release
assets or updater feeds without reconciling the published version and affected
clients first.
