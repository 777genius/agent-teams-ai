# Project access boundaries

This document defines the provider-neutral access model used for managed
workers. It is separate from provider sandbox flags such as Codex
`workspace-write` or `danger-full-access`.

## Boundary enum

```ts
enum AccessBoundary {
  ReadOnly = "read_only",
  IsolatedWorkspaceWrite = "isolated_workspace_write",
  ProjectScopedControl = "project_scoped_control",
  DangerFullAccess = "danger_full_access",
}
```

## Semantics

- `ReadOnly`: can inspect scoped project state and run read-only diagnostics.
  It cannot write files, create jobs, start workers or push branches.
- `IsolatedWorkspaceWrite`: can write only inside its isolated workspace roots.
  It cannot write registry files, auth roots, `.git` internals, docker sockets
  or create child workers.
- `ProjectScopedControl`: can coordinate a project through brokered operations:
  create project jobs, create project worktrees, start/stop project workers,
  write review markers, integrate commits and push allowed branches. It should
  not receive unrestricted raw shell.
- `DangerFullAccess`: explicit escape hatch for full host access. Launch plans
  must require an explicit acknowledgement before enabling it.

## Enforcement model

The model is intentionally layered:

1. LLM proposes an action.
2. Runtime checks `AccessPolicyService`.
3. Broker executes structured project-control operations.
4. Sandbox enforces filesystem/tool/network limits.
5. Audit/events record decisions without secrets.

Do not rely on prompt instructions or command parsing as the primary safety
mechanism. Command validation is useful as a secondary deny list, but the
reliable boundary is brokered operations plus a sandbox that prevents raw
filesystem and tool escape.

Launch plans include a provider-neutral `CommandPolicy` for adapters that can
intercept tool or shell calls. The policy denies common escape paths such as
`git push`, `tmux`, Docker, SSH-style tools, inline interpreter execution like
`python -c` or `node -e`, direct shell script execution via `sh`/`bash`/`zsh`,
and direct references to scoped registry roots. This layer must fail closed
when an adapter advertises command validation support, but it is still only a
secondary guard. Ordinary safety must not depend on parsing arbitrary shell.

The Codex file-backend adapter enforces this policy at the `RunnerPort`
boundary before spawning provider processes. A denied command returns
`command_policy_denied:*` and the inner runner is not invoked. This makes
command policy an executable guard rather than documentation, while the
filesystem sandbox and broker remain the primary boundary.
Denied commands emit a `command_policy.denied` runtime event with the decision
reason and executable name only. Raw command arguments are not recorded.

## Edge cases covered by policy tests

- similar path prefixes, for example `/work/project` vs `/work/project-other`;
- `..` traversal through normalized absolute paths;
- symlink escape when a caller provides both requested path and real path;
- direct `.git` internals access;
- direct registry writes by non-broker operations;
- auth root and docker socket access;
- wrong job id, tmux, branch and remote prefixes;
- force pushes unless project scope explicitly allows them;
- launch fail-closed when an adapter cannot enforce the requested boundary.

## Provider sandbox mapping

Provider sandbox settings are still provider-specific low-level controls.
`AccessBoundary` is the higher-level runtime contract:

- `IsolatedWorkspaceWrite` may map to provider `workspace-write` when the
  adapter can enforce the workspace roots.
- `ProjectScopedControl` should expose project-control broker tools and disable
  unrestricted raw shell.
- `DangerFullAccess` may map to provider `danger-full-access`, but only through
  an explicit launch acknowledgement and audit trail.

Current Codex adapter status:

- legacy jobs without `accessBoundary` keep existing behavior except raw
  `providerSandboxMode: "danger-full-access"` is rejected. Full access must use
  `accessBoundary: "danger_full_access"` with explicit acknowledgement;
- `isolated_workspace_write` maps to Codex `workspace-write`. When a runtime
  command policy is present, Codex app-server command approval requests are
  reviewed by the runtime policy before the app-server receives approval;
- Codex access-boundary jobs must set `networkAccess: "restricted"`.
  The adapter fails closed for implicit or explicit `disabled` network mode until
  a real OS/container egress sandbox exists;
- provider-side permission expansion and file-change approval requests are
  denied fail-closed. Project integration writes must use brokered integration
  tools instead;
- `danger_full_access` maps to Codex `danger-full-access` only when explicitly
  acknowledged;
- job manifests with an `accessBoundary` are validated before registry write.
  Unsupported or unenforceable boundaries fail closed instead of being stored;
- registry writes also check manifest consistency against `ProjectAccessScope`:
  workspace paths must be inside scoped roots, scoped accounts must match, and
  brokered project-control manifests must match project job/tmux prefixes.
  Existing workspace paths are checked with `realpath` so symlink escapes fail;
- `project_scoped_control` fails closed for ordinary Codex agent launches. A
  controller manifest can operate only through broker MCP tools such as
  `codex_goal_project_create_job`, `codex_goal_project_start`,
  `codex_goal_project_stop`, `codex_goal_project_mark_reviewed`,
  `codex_goal_project_create_worktree`,
  `codex_goal_project_integrate_commit` and
  `codex_goal_project_push_branch`.

Codex broker git/worktree operations use fixed structured requests and
`execFile("git", args)` with no shell interpolation. The broker validates
workspace roots, worktree roots, branches, remotes, force-push policy and
commit SHA shape before executing git. Push force mode uses `--force-with-lease`
and is denied unless project scope explicitly allows force push.

## Project controller recipe

For a long-running project coordinator, create a stored controller job with
`accessBoundary: "project_scoped_control"` and a tight `projectAccessScope`.
The controller is a policy anchor for broker calls, not an ordinary raw-shell
writer. It should coordinate child jobs only through project-control tools.

Minimum safe scope:

- `registryRoot`: the single worker registry this controller may write through
  the broker;
- `workspaceRoots`: existing project integration/checkpoint workspaces;
- `worktreeRoots`: parent directories where child worktrees may be created;
- `jobIdPrefixes`: project-specific prefixes for child job ids and job roots;
- `tmuxSessionPrefixes`: project-specific prefixes for child worker sessions;
- `allowedBranches`: branches the controller may integrate or push;
- `allowedGitRemotes`: usually `origin`;
- `allowedAccountIds`: optional account allow-list for child worker manifests.

The expected control loop is:

1. inspect status with read-only tools;
2. create a scoped worktree with `codex_goal_project_create_worktree`;
3. create a child job with `codex_goal_project_create_job`;
4. start it with `codex_goal_project_start`;
5. review the child diff and verification evidence;
6. write a review marker with `codex_goal_project_mark_reviewed`;
7. integrate reviewed commits with `codex_goal_project_integrate_commit`;
8. push allowed branches with `codex_goal_project_push_branch`.

`codex_goal_project_integrate_commit` and `codex_goal_project_push_branch`
are low-level broker operations. They validate scope, branch, remote and force
policy, but they do not by themselves prove that a worker output has passed the
full autonomous integration gate. Policy-controlled merge rights should use the
Project Integration lifecycle in `worker-core/integration`: open attempt, apply
worker output, run required checks, create a commit candidate, then push or
reject.

The broker rejects child manifests that try to override the controller-owned
scope, request `danger_full_access`, request `project_scoped_control`, use
unapproved accounts, write job roots outside the registry base, or use
workspace paths outside the controller scope.
