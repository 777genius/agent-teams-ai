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
   honor `ELECTRON_INSTALL_PLATFORM` when repairing `path.txt`. Verify a clean
   frozen install and a missing binary recovery path.
3. Raise the macOS minimum from 12 to 13 because Electron 44 cannot run on
   macOS 12. Update the landing page and release metadata. `latest-mac.yml`
   must declare Darwin `minimumSystemVersion: 22.0.0` so installed macOS 12
   clients do not download an app they cannot launch.
4. Rebuild and load `better-sqlite3`, `node-pty`, and `ssh2`'s optional
   `cpu-features` module for Electron 44's native ABI. Keep `node-abi` current
   enough to recognize Electron 44 and regenerate `cpu-features/buildcheck.gypi`
   before rebuild. Verify the actual packaged modules, not only install exit codes.
5. Run typecheck, affected tests, build, and exact-head CI. Package and smoke
   macOS arm64/x64, Windows x64/arm64, and Linux x64 using isolated test
   profiles and new sandbox/test projects. Verify renderer startup, SQLite,
   PTY open/close, MCP handshake, and cleanup where supported. The packaged
   smoke matrix runs in `.github/workflows/electron-packaged-ci.yml`.
6. Review the final package bytes, native ABI, OS support, and platform logs.
   Keep #760 separate; after both PRs merge, run focused combined checks on
   their integrated head.

## Definition of done

- Exact Electron package/version and embedded Node are recorded from the built
  application; manifests, lockfile, installer code, and docs agree.
- All targeted native modules load in packaged apps; failed rebuilds are not
  masked as success.
- Exact-head CI passes and packaged desktop smoke has evidence for every
  supported OS/arch. A missing platform is `NOT VERIFIED`, not a pass.
- An installed macOS 12 build rejects the new updater feed, while macOS 13+
  remains eligible. Verify `latest-mac.yml` before any release publication.
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

| Risk | Required evidence before release |
| --- | --- |
| Native rebuild fails but `postinstall` continues | Explicit rebuild and packaged SQLite/PTy checks pass on every target. |
| macOS 12 auto-updates into an unsupported binary | Check the generated updater feed against Darwin 21 and 22 before publication. |
| macOS notification behavior changed in Electron 42 | Test delivery from a signed macOS candidate; an unsigned CI app cannot prove it. |
| Native folder picker defaults changed | Check project import and folder selection UX on a packaged candidate. |
| Linux window controls changed | Check custom decorations on the Linux packaged candidate. |

Rollback is a revert of this PR plus republication of the last verified
Electron 41 build if a release has already shipped. Do not overwrite release
assets or updater feeds without reconciling the published version and affected
clients first.
