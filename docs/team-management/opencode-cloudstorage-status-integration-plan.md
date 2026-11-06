# CloudStorage-safe OpenCode status — desktop integration

Date: 2026-11-06. Dependent on `agent_teams_orchestrator#222` and a newly released pinned runtime with `runtime status --project-path`.

## Evidence
Screenshot shows macOS Google Drive File Provider project path, bundled Bun command exiting with `Unexpected`, plus separate OpenCode local-config inspection failure. Bun upstream issue #44606 reproduces `realpath` EPERM in Bun 1.4.2 on File Provider folders.

## Design and critical reviews
- **Reliability review:** Merely changing `cwd` to `HOME` is incorrect: it silently substitutes home model/config. Always pass the *original selected project* as the explicit `--project-path` argument to full `runtime status`. Only OpenCode on macOS relocates; others retain their previous arguments/cwd.
- **Security review:** Do not bypass actual filesystem permissions, or mark model/launch ready from a passive summary. Check selected project directory existence before relocating so a missing directory still fails closed. Pass path as argv, not shell text. No feature flag.
- **Architecture review:** One shared leaf helper, used by status UI and team-preflight status. No edits to actual CLI/host execution cwd. Do not touch live projects or runtime installer mechanics.
- **Release compatibility:** Until the compatible runtime binary is published and pinned in `runtime.lock.json`, keep this PR unmerged; don't silently fall back to an incompatible old binary.

## Verification
- Focused unit tests: macOS path with spaces, other platforms/providers, absent/invalid projects and missing-directory preservation.
- CLI argument/scope contract with the compatible orchestrator version.
- Full typecheck, lint and root tests, packaged macOS Electron smoke where CI can run it.
- Independent CodeRabbit/Codex review and fixes, then HEAD-guarded merge.
- Real third-party Google Drive TCC environment cannot be accessed here; deny genuine permission failures and document that limitation.

Approximate implementation ~45–90 production LOC plus ~70–130 test LOC. 
