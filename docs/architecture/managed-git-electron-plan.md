# Managed Git for Agent Teams Electron — implementation plan

Status: **draft plan**. Scope: local desktop builds (macOS arm64/x64, Windows arm64/x64, Linux x64). Keep PR #1113 (guard against Apple's installer shim) independent; do not copy its patches into this feature branch.

## Goal and acceptance criteria

A signed, installed desktop app ships usable Git **offline**, so a user on a clean macOS installation can create a team, select a project, inspect Git status/diffs and choose teammate Git-worktree isolation without installing Xcode Command Line Tools, Homebrew or system Git. Real agent subprocesses (Claude Code, Codex, OpenCode, etc.) spawned by Agent Teams resolve the same managed Git via inherited `PATH`. Ordinary dashboard navigation never invokes Git unnecessarily.

- No calls to the `/usr/bin/git` installer shim in covered **app-owned** code paths.
- Existing user Git config, SSH keys and credential-helper policies survive unchanged. Never silently run `git init`, `commit` or install software.
- Worktree isolation still requires a real repository/initial commit; errors are actionable without OS popups.
- Build is deterministic: fixed upstream release + SHA-256 per OS/architecture, staged by CI, never downloaded on users' machines, verifies all required files before packaging.
- Git executables, helpers, configs and libraries live outside `app.asar`; macOS hardened-runtime signing/notarization, Windows/Linux packaging and upgrades remain valid.
- No real user projects are accessed by tests. Full local/E2E acceptance uses disposable repositories.
- **Honest boundary:** external agents that explicitly execute `/usr/bin/git`, wipe `PATH`, or run on SSH hosts are not controlled by the desktop bundling.

## Upstream choice

Use **desktop/dugite-native** Git runtime archives, not Dugite JS `postinstall` and not a new Git implementation or libgit2 dependency. Upstream release candidate: `v2.56.0-2` (Git 2.56.0). Confirm redistribution terms for Git GPLv2, Git LFS, credential helpers and other bundled components. Collect third-party notices/source-offer documentation with the release; legal compliance is a release gate. Pin full archive checksums from the upstream .sha256 release assets; no moving `latest` URLs.

The archive is a **complete Git distribution**, not a single `git` executable. Preserve `bin/git`, `libexec/git-core`, certificate/config/template data, shared libraries, and Windows `cmd/git.exe`, `ucrt64` or `clangarm64` subtrees. Do not prune runtime components until tests prove safe.

## Architecture (minimal, no service/microservice)

1. `managed-git.lock.json` describes only 5 target runtimes with filename, expected digest and source URL/tag. A small `scripts/stage-managed-git.mjs` downloads a **single** target archive into a temporary directory, checks SHA-256 before extraction, prevents traversal/symlink escapes and atomically stages under `resources/git`. Fail closed for unsupported platforms or missing hashes.
2. electron-builder `build.extraResources` includes `resources/git -> git`. CI/release staging must run before app packaging, including macOS arm64/x64 signing and Windows x64/arm64. Build-time checks assert the target binary and helper directories.
3. One pure main-process module `src/main/utils/managedGit.ts` exposes `getGitExecutable()`, `createManagedGitEnv(env)`, and `createManagedGitPath(env)`. Release builds use only `process.resourcesPath/git` and **never** fallback to system `git` if payload is absent/corrupt; source/dev mode may intentionally use real system Git when no staged payload is available. Avoid constructing commands in shell strings.
4. Inject the resolved **absolute executable** into `execFile` calls for `TeamWorktreeGitService`, `TeamMemberWorktreeManager`, `GitDiffFallback`. Configure `simple-git({binary: ...})` for `GitStatusService` and `FileSearchService`, retain status/search graceful fallbacks. Where Git status is only informational, skip it entirely when unavailable.
5. Preserve the existing single launch-environment plumbing: add Git's bin and necessary helper directories ahead of system paths in `buildEnrichedEnv` / `buildRuntimeBaseEnv` after merge, and at any independent team-provisioning, terminal, MCP, and external agent launch seam that bypasses them. Preserve user config (don't overwrite `HOME`, `GIT_CONFIG_GLOBAL`, SSH settings); constrain `GIT_EXEC_PATH`, `GIT_TEMPLATE_DIR`, `GIT_CONFIG_SYSTEM`, Linux `PREFIX`/CA and Windows DLL lookup to the bundle. Never mutate global `process.env.PATH`.
6. No user-facing settings toggle for initial release. Bundled Git is the default; developer/source mode remains usable. Do not add feature flags, runtime downloads or a registry.

## Risks and mitigations

| Risk | Mitigation |
| --- | --- |
| macOS hardened runtime rejects bundled executable / dylibs | Sign every required Mach-O before outer app sign; notarize installed DMG and verify with `codesign`, `spctl` and actual subprocess launch |
| Windows Git execution depends on helper DLLs and config | Stage complete per-arch distribution, resolve `cmd/git.exe`, add matching `ucrt64` / `clangarm64` dirs to child PATH, verify `git --exec-path` and Git LFS |
| Linux portable Git needs CA/config/PREFIX | Match upstream Dugite environment construction and test installed AppImage/deb |
| Repository hooks can run arbitrary commands | Existing user-consented Git operations only; never invoke hooks during passive detection; do not elevate privileges |
| Unexpected extra binary size | Compare install artifact size against baseline, report measured delta, avoid speculative trimming |
| CLI runtime rebuilds PATH | Verify final merged environment and the first actual child; add tests at each independent env boundary |
| SSH remote Git | Run on remote host; preserve explicit remote capability/error, don't pretend the local binary is remote |
| Supply-chain and GPL/notice obligations | Verified immutable assets, published provenance, complete notices/source-offer compliance before shipping |
| CI catches TypeScript but not native macOS modal | Dedicated macOS clean-CLT E2E on signed app, plus Windows/Linux packaged scenarios; report any unavailable native machine as an unverified requirement |

## Execution order, pushes and review gates

1. **This commit:** push plan to a new branch, immediately create a **draft PR**. Subsequent commits all push to that same draft PR.
2. **Critic round 1 — architecture/security:** check process boundaries, binary resolution, shell injection, PATH precedence, code signing, upstream provenance, GPL obligations, no duplicated infrastructure. Correct plan.
3. **Critic round 2 — release/E2E:** check each architecture and updater workflow, macOS arm64/x64 signing, Windows ARM64 layout, Linux portable CA, production source guards, clean environment tests. Correct plan. Use available independent PR review; don't claim to have run other agents when not available.
4. Implement in scoped commits, pushing each immediately: deterministic staging/lock, packaged integration, main-process adapters, child environments, tests/CI.
5. Run focused tests, TypeScript 7 typecheck, lint, CI, packaged smoke with disposable fixtures on supported OS targets. Validate Git commands from both app and actual agent-spawn environments; collect measured binary and installer sizes.
6. Address review comments; repeat E2E at final HEAD. Mark PR ready only after required checks and actual native evidence pass; merge via normal repo policy only after full qualification. **Never claim native E2E passed from a Linux-only environment.**

## Explicitly out of scope

Replacing `simple-git`, rewriting Git in JS/Rust, implementing Git GUI, auto-installing system Git, Git server/SaaS dependency, elevating privileges, requiring Git for non-Git projects, modifying unrelated repositories or PR #1113, supporting arbitrary remote-host packaging, or changing the app's authentication model.

## Stop/go checklist

- [ ] Verified lockfile and 5 staged runtime platform variants
- [ ] App-owned Git routes use managed absolute executable; non-Git paths untouched
- [ ] Agent, team, terminal and MCP child PATH tests demonstrate inheritance
- [ ] Git status, diff, worktree, LFS, clone, SSH/keychain behavior checked
- [ ] Packaged macOS arm64/x64 signed and notarized; clean machine without CLT launches without system prompt
- [ ] Windows x64/arm64 and Linux x64 packaged tests
- [ ] License/third-party source obligations published
- [ ] Independent code review and required current-HEAD CI green
- [ ] Final app release validated; only then merge
