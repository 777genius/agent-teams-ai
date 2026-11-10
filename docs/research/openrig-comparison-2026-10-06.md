# OpenRig comparison evidence

Checked October 6, 2026 via GitHub CLI against stable **v0.6.5**, published October 4, commit **`5ea35e93bca9460db94da0fc31afbc3716ea14ba`**. No agent runtime was launched. Newer default-branch features are not assumed to be released. Other competitors were not re-audited; their existing evidence dates remain unchanged.

OpenRig is the last column in both the README and landing tables. Yes credits an implemented capability; partial identifies narrower scope or optional maintenance surfaces. Negative findings describe the inspected release, not every possible external integration.

| Existing row | Assessment | Detail and release-pinned evidence |
| --- | --- | --- |
| Live team collaboration | Yes, editorial 8/10 | Stable roles, peer messaging, durable ownership, blockers, completion and reviewer handoffs. [README][readme], [coordination][queue]. |
| Human control and approvals | Yes | Native permissions, audited future-launch seat policies, typing guard and human approval gates. Desired policy does not prove current native enforcement. [README][readme], [RigSpec][spec], [proof approvals][review]. |
| Visual team progress | Yes | TUI topology table/graph, seat states, activity feed and mission execution views. Different presentation from our graphical task/log map. [README][readme], [mission review][review]. |
| Team workspace | Partial | TUI coordination and actual tmux/herdr/cmux terminals are separate surfaces. React web UI is optional and in maintenance mode. [README][readme]. |
| Easy setup | Partial | Node 22/24, tmux and a selected authenticated runtime required. Guided setup exists; native Windows is unsupported. [README][readme]. |
| Agent readiness and recovery | Yes | Readiness checks, snapshots, attention states and distinct per-seat restore outcomes. Resume, rebuild and failed recovery are not interchangeable. These contracts do not establish measured reliability. [Lifecycle][restore]. |
| Kanban board | No | Owned-work queue and mission views exist. No Kanban board found in the inspected release. Lack of Kanban does not mean lack of tasks. [Queue][queue], [mission views][review]. |
| Code review | Partial | Reviewer rigs and proof approvals exist. No task-scoped inline diff/hunk accept-reject-comment surface equivalent to our Changes viewer found. [README][readme], [review][review]. |
| Cross-team communication | Yes | Messages, broadcasts, chatrooms and cross-rig/host handoffs. Cross-host routing requires configuration. [README][readme], [queue][queue]. |
| Linked tasks | Yes | Blockers, ownership, handoff lineage and workflow dependencies. Transactional handoff closes one row and creates the successor. [Coordination][queue]. |
| Agent activity and history | Yes | Activity feed, transcripts, append-only queue transitions and usage telemetry. Telemetry detail varies by runtime; do not imply identical tool/cost attribution for all providers. [README][readme], [queue][queue], [usage CLI][usage]. |
| Organizations & global overview | Partial | Rigs, pods and seats with topology and fleet views. No editable nested company organization map equivalent to ours found. [RigSpec][spec], [fleet views][review]. |
| Mixed AI teammates | Yes | Claude Code and Codex are primary; Pi and Oh My Pi runners have additional auth/state/restore caveats. Supported does not mean every combination was live-tested. [README][readme], [RigSpec][spec]. |
| Budget controls | Partial | Token/hour and provider-window monitoring. Relevant source/documentation search found no financial budget enforcement. Context selection `--budget` is not a spending cap. [Usage CLI][usage]. |
| Separate agent workspaces | Partial | Per-seat `cwd` and support for externally created Git worktrees. No automatic per-agent Git worktree creation/cleanup lifecycle found. `worktree-builds.md` describes building OpenRig itself, not this product feature. [RigSpec][spec], [Codex Git metadata support][worktrees]. |
| Terminal | Yes | Interactive tmux sessions, herdr/cmux integration and optional web terminal. Web surfaces are in maintenance mode. [README][readme]. |
| Built-in code editor | Partial | Basic FilesWorkspace text editing, save/cancel and conflict handling in optional maintenance web UI. Calling the editor entirely absent would be inaccurate. [Editor source][editor]. |
| Task attachments | Partial | Queue evidence refs, proof artifacts and Slack file attachments. Inbound files become workspace-local copies referenced in queue bodies; outbound uploads support images/video/PDF. Different from first-class Kanban attachments. [Proofs][review], [inbound files][inbound], [outbound files][outbound]. |
| Price | Free OSS | Apache-2.0 software; selected provider usage and any hosting costs remain. Free software does not imply free model access. [README][readme]. |

## Methodology and limits

The 8/10 live collaboration score is a qualitative editorial assessment of communication, ownership, dependencies, completion and review, not a performance or reliability benchmark. Terminal-first operation and optional maintenance web surfaces limit the integrated user workflow, but do not negate durable coordination capabilities.

The existing table does not have dedicated declarative-team, portable-bundle or snapshot rows. OpenRig's RigSpec/AgentSpec and continuity features are strengths outside that row selection; this table is not an exhaustive inventory or overall maturity ranking. The [v0.6.5 release notes](https://github.com/mvschwarz/openrig/releases/tag/v0.6.5) describe known limitations and unverified live-runtime combinations.

[readme]: https://github.com/mvschwarz/openrig/blob/5ea35e93bca9460db94da0fc31afbc3716ea14ba/README.md
[spec]: https://github.com/mvschwarz/openrig/blob/5ea35e93bca9460db94da0fc31afbc3716ea14ba/docs/reference/rig-spec.md
[queue]: https://github.com/mvschwarz/openrig/blob/5ea35e93bca9460db94da0fc31afbc3716ea14ba/docs/as-built/architecture/coordination-primitive.md
[restore]: https://github.com/mvschwarz/openrig/blob/5ea35e93bca9460db94da0fc31afbc3716ea14ba/docs/as-built/architecture/lifecycle-snapshot-restore.md
[review]: https://github.com/mvschwarz/openrig/blob/5ea35e93bca9460db94da0fc31afbc3716ea14ba/docs/as-built/architecture/living-notes-review.md
[usage]: https://github.com/mvschwarz/openrig/blob/5ea35e93bca9460db94da0fc31afbc3716ea14ba/packages/cli/src/commands/usage.ts
[worktrees]: https://github.com/mvschwarz/openrig/blob/5ea35e93bca9460db94da0fc31afbc3716ea14ba/packages/daemon/src/domain/codex-git-add-dirs.ts
[editor]: https://github.com/mvschwarz/openrig/blob/5ea35e93bca9460db94da0fc31afbc3716ea14ba/packages/ui/src/components/files/FilesWorkspace.tsx
[inbound]: https://github.com/mvschwarz/openrig/blob/5ea35e93bca9460db94da0fc31afbc3716ea14ba/packages/daemon/src/domain/gateway/slack/inbound.ts
[outbound]: https://github.com/mvschwarz/openrig/blob/5ea35e93bca9460db94da0fc31afbc3716ea14ba/packages/daemon/src/domain/gateway/slack/slack-delivery.ts
