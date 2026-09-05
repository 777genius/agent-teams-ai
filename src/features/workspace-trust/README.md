# Workspace trust

Owns the existing launch trust preparation and a read-only, provider-aware launch hint.

- `contracts`: browser-safe status DTOs and IPC/HTTP channel names.
- `core`: path semantics, pure Codex override planning and Claude launch preparation.
- `main`: read-only status use case, filesystem/config adapters and shared validated facade.
- `preload`: the optional `getLaunchStatus` bridge alongside legacy Claude-only `getProjectStatus`.
- `renderer`: request lifecycle, conservative status aggregation and the shared compact hint.

Claude status comes from its persisted trust source. Codex `launch_scoped` means the existing
override planner applies to the selected project; it does not mean persisted trust, runtime
readiness, successful launch, or coverage of future teammate worktrees. Codex's hint may repeat.

Status reads never launch a CLI, write settings, change permissions or gate Launch/Skip. Unsupported
remote contexts and unavailable evidence are unknown. IPC and HTTP use the same validated facade;
the status DTO contains no config/auth contents or raw diagnostics. The renderer discards stale
responses and ends a pending read after two seconds.

See `docs/team-management/codex-claude-workspace-trust-status-plan.md` for scope and verification.
