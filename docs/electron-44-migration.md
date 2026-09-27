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
2. Adapt binary download/bootstrap for Electron 42's change away from an
   automatic postinstall download. Verify a clean frozen install and a missing
   binary recovery path, rather than relying on an existing local cache.
3. Raise the macOS minimum from 12 to 13 because Electron 44 cannot run on
   macOS 12. State that compatibility change in installation/release guidance.
4. Rebuild and load `better-sqlite3`, `node-pty`, and `ssh2` for Electron 44's
   native ABI. Verify the actual packaged modules, not only install exit codes.
5. Run typecheck, affected tests, build, and exact-head CI. Package and smoke
   macOS arm64/x64, Windows x64/arm64, and Linux x64 using isolated test
   profiles and new sandbox/test projects. Verify renderer startup, SQLite,
   PTY open/close, MCP handshake, and cleanup where supported.
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
