# Team Management Feature

UI for managing AI teammate teams inside Agent Teams (Electron), including Claude, Codex, and OpenCode runtime paths.

## What It Does

- Shows team members and their roles.
- Provides a Kanban board with 5 columns: TODO, IN PROGRESS, REVIEW, DONE, APPROVED.
- Sends messages to teammates through inbox files and runtime-aware delivery for OpenCode.
- Supports review flow: review requests, manual review, and direct manual approval from DONE.
- Provides live updates through the file watcher.

## Documentation

| File                                                                                   | Contents                                                                                                              |
| -------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| [research-inbox.md](./research-inbox.md)                                               | Inbox file format, race conditions, atomic writes, message delivery                                                   |
| [research-tasks.md](./research-tasks.md)                                               | Task file format, .lock, .highwatermark, concurrent access                                                            |
| [research-messaging.md](./research-messaging.md)                                       | Comparison of inbox, SDK, and CLI approaches, and why inbox was chosen                                                |
| [kanban-design.md](./kanban-design.md)                                                 | Kanban flow, columns, review mechanism, kanban-state.json                                                             |
| [implementation.md](./implementation.md)                                               | Technical plan: files, steps, verification                                                                            |
| [openclaw-agent-teams-integration.md](./openclaw-agent-teams-integration.md)           | How to connect OpenClaw or another outside AI through Agent Teams MCP and REST control API                            |
| [research-worktrees.md](./research-worktrees.md)                                       | Git worktrees + teams, launching Claude processes from the UI (Phase 2)                                               |
| [task-queue-derived-agenda-plan.md](./task-queue-derived-agenda-plan.md)               | Detailed rollout plan for queue/inventory split, derived actionOwner, and phased agenda/delta sync                    |
| [debugging-agent-teams.md](./debugging-agent-teams.md)                                 | Runtime debugging runbook, including `CLAUDE_TEAM_TEAMMATE_MODE=tmux` for pane-backed teammate debug                  |
| [team-provisioning-target-architecture.md](./team-provisioning-target-architecture.md) | Normative target architecture and strangler migration rules for Team Provisioning                                     |
| [adaptive-task-graphs-research-note.md](./adaptive-task-graphs-research-note.md)       | Research note on LATTE/AgentConductor: dynamic task graphs, frontier scheduling, selective verify, release stragglers |

## Key Decisions

Warning: `docs/iterations/*` contains historical planning notes. These files are useful for context, but they are not the source of truth for current product behavior. The current review-flow contract is documented here and in [kanban-design.md](./kanban-design.md).

Warning: Team Provisioning implementation plans and research notes are point-in-time context and do not override [team-provisioning-target-architecture.md](./team-provisioning-target-architecture.md). Older instructions to add orchestration directly to `TeamProvisioningService` must be implemented as thin-facade delegation to composed use cases.

Warning: `agent-attachments-*.md` files (architecture plan + phase 1-5 plans) are historical design documents for feature attachments. The actual implementation in `src/features/agent-attachments/` may differ from that architecture. For current behavior, see the code in `src/features/agent-attachments/core/domain/` and the tests.

### 1. Messaging: Inbox + Runtime Delivery

For native Claude/Codex-style teammates, the primary path is durable inbox files. Lead inbox delivery uses `relayLeadInboxMessages()` because the lead reads stdin. OpenCode secondary lanes do not read `inboxes/{member}.json` directly, so the UI first persists the message to the inbox and then delivers it through the runtime bridge with delivery proof. Details: [research-messaging.md](./research-messaging.md) and [debugging-agent-teams.md](./debugging-agent-teams.md).

### 1.1 Roster Source: members.meta.json + inboxes

- `config.json` is not used as the complete member registry. It may contain only the team lead and CLI service fields.
- Member metadata source (role/color/agentType): `members.meta.json`.
- Runtime membership and message-addressing source: `inboxes/{member}.json`.

### 2. Kanban Storage: Dedicated File

Kanban position (REVIEW, APPROVED) is stored in `kanban-state.json`, not task metadata. Reason: task metadata may be overwritten by an agent during TaskUpdate. Details: [kanban-design.md](./kanban-design.md).

### 3. Review Flow: Approve / Request Changes

- Reviewers exist in the team -> automatic assignment through inbox.
- The user can also manually approve a task directly from `DONE` without entering `REVIEW`.
- No reviewers -> manual user review (Approve / Request Changes in the UI).
- Request Changes -> the user optionally describes the issue -> the task returns to its owner in `pending` with `needsFix`.

### 4. Atomic Write

All writes use tmp + rename to prevent corrupted JSON.

### 5. Sender Identity

Messages are sent with `from: "user"`. Fallback to `from: "team-lead"` exists only if needed.

## Final Decisions After Review

After 3 review rounds with 13 experts, the following decisions were accepted.

### Inbox: Atomic Write + messageId Verify

- Atomic write (tmp + rename) prevents corrupted JSON.
- After writing, read the file back and verify that our `messageId` is present.
- A full CAS/retry loop is not needed for MVP. Verification on the next read is enough.
- Race condition risk with an agent is real, but probability is low.

### Kanban: kanban-state.json With Safe GC

- Stale `kanban-state` entries are garbage-collected only after all tasks are fully loaded.
- Otherwise, startup can race: GC may delete an entry before the task file has been read.

### Review Flow: Approve / Request Changes

- Buttons were renamed: **Approve** instead of OK, and **Request Changes** instead of Error.
- Request Changes comment is optional.
- Manual UI allows two valid paths:
  - `DONE -> REVIEW -> APPROVED`
  - `DONE -> APPROVED` as fast manual approval
- `Request Changes` removes the kanban-state entry and returns the task to `pending` with `needsFix`.
- `reviewHistory` and round-robin balancing are Phase 2, not MVP.

### Members: Complete List Through Union

- `union(members.meta.json + config members + inbox filenames + task owners)` is the only way to get the complete member list.
- `owner` in task files is optional. An agent may not have an owner before assignment.

### Graceful Degradation

- `try/catch` is used throughout `TeamDataService`; read errors return safe defaults.
- Member has 3 states: `ACTIVE` / `IDLE` / `TERMINATED`.
  - `ACTIVE`: idle < 5 minutes
  - `IDLE`: idle > 5 minutes
  - `TERMINATED`: received `shutdown_response` with `approve: true`

### @dnd-kit and Review Transitions

- Transitions between review columns happen through card actions in the UI.
- `@dnd-kit` is currently used primarily for reordering tasks inside a column.
- Phase 2: full drag-and-drop through `@dnd-kit`.

---

## Open Questions

- **FileWatcher extension**: FileWatcher.ts is already 1243 lines. Adding teams/tasks watchers is non-trivial and needs a separate spike.
- **Windows atomic rename**: `fs.renameSync` on Windows can throw `EXDEV`/`EBUSY` for cross-device rename. A wrapper is needed.
- **leadSessionId integration**: config.json contains `leadSessionId`, but integration with the session viewer (navigating to the lead session) remains open.
- **Hard Interrupt**: messages are delivered between turns with a 1-30 second delay. A future mechanism is needed to interrupt mid-turn.
- **Archival**: inbox is not cleaned automatically. An "Archive" button is needed.

## Claude Code File Structure

```text
~/.claude/
├── teams/{teamName}/
│   ├── config.json                # Team config (lead + service fields)
│   ├── members.meta.json          # Member roles/colors/types (teammates)
│   └── inboxes/{memberName}.json  # Inbox for each member
└── tasks/{teamName}/
    ├── {id}.json                  # Task file
    ├── .lock                      # Lock file (0 bytes)
    └── .highwatermark             # Latest task ID
```

**Important**:

- `config.json` is not the source of truth for the complete roster.
- The UI builds the complete roster from `members.meta.json + inbox filenames (+ lead from config)`.
