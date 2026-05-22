<p align="center">
  <a href="docs/screenshots/1.jpg"><img src="docs/screenshots/1.jpg" width="75" alt="Kanban Board" /></a>&nbsp;
  <a href="docs/screenshots/7.png"><img src="docs/screenshots/7.png" width="75" alt="Code Review" /></a>&nbsp;
  <a href="docs/screenshots/2.jpg"><img src="docs/screenshots/2.jpg" width="75" alt="Team View" /></a>&nbsp;
  <a href="docs/screenshots/8.png"><img src="docs/screenshots/8.png" width="75" alt="Task Detail" /></a>&nbsp;
  <img src="resources/icons/png/1024x1024.png" alt="Agent Teams" width="80" />&nbsp;
  <a href="docs/screenshots/9.png"><img src="docs/screenshots/9.png" width="75" alt="Execution Logs" /></a>&nbsp;
  <a href="docs/screenshots/3.png"><img src="docs/screenshots/3.png" width="75" alt="Agent Comments" /></a>&nbsp;
  <a href="docs/screenshots/4.png"><img src="docs/screenshots/4.png" width="75" alt="Create Team" /></a>&nbsp;
  <a href="docs/screenshots/6.png"><img src="docs/screenshots/6.png" width="65" alt="Settings" /></a>
</p>

<h1 align="center"><a href="https://777genius.github.io/agent-teams-ai/">Agent Teams</a></h1>

<p align="center">
  <strong><code>You're the CTO, agents are your team. They handle tasks themselves, message each other, review each other. You just look at the kanban board and drink coffee.</code></strong>
</p>

<p align="center">
  <a href="https://github.com/777genius/agent-teams-ai/releases/latest"><img src="https://img.shields.io/github/v/release/777genius/agent-teams-ai?style=flat-square&label=version&color=blue" alt="Latest Release" /></a>&nbsp;
  <a href="https://github.com/777genius/agent-teams-ai/actions/workflows/ci.yml"><img src="https://github.com/777genius/agent-teams-ai/actions/workflows/ci.yml/badge.svg" alt="CI Status" /></a>&nbsp;
  <a href="https://discord.gg/qtqSZSyuEc"><img src="https://img.shields.io/badge/Discord-Join%20us-5865F2?style=flat-square&logo=discord&logoColor=white" alt="Discord" /></a>
</p>

<p align="center">
  <sub>Free desktop app for AI agent teams. Start with a free model with no auth - no signup, API key, or card - or connect Claude/Codex/OpenCode provider access for more models. Not just coding agents.</sub>
</p>

<img width="1304" height="820" alt="image" src="https://i.imgur.com/AugQy1B.jpeg" />

<a href="https://777genius.github.io/agent-teams-ai/">Watch demo on the site or here:</a>


https://github.com/user-attachments/assets/d1a85fe5-fb49-4009-b2c1-79ae8818e8c4

<table>
<tr>
<td width="50%">

https://github.com/user-attachments/assets/9cae73cd-7f42-46e5-a8fb-ad6d41737ff8

</td>
<td width="50%">

https://github.com/user-attachments/assets/35e27989-726d-4059-8662-bae610e46b42

</td>
</tr>
</table>

<br />

## Installation

No prerequisites - the app can detect supported runtimes/providers and guide setup from the UI.

<table align="center">
<tr>
<td align="center">
  <a href="https://github.com/777genius/agent-teams-ai/releases/latest/download/Agent.Teams.AI-arm64.dmg">
    <img src="https://img.shields.io/badge/macOS_Apple_Silicon-.dmg-000000?style=for-the-badge&logo=apple&logoColor=white" alt="macOS Apple Silicon" />
  </a>
  <br />
  <a href="https://github.com/777genius/agent-teams-ai/releases/latest/download/Agent.Teams.AI-x64.dmg">
    <img src="https://img.shields.io/badge/macOS_Intel-.dmg-434343?style=for-the-badge&logo=apple&logoColor=white" alt="macOS Intel" />
  </a>
</td>
<td align="center">
  <a href="https://github.com/777genius/agent-teams-ai/releases/latest/download/Agent.Teams.AI.Setup.exe">
    <img src="https://img.shields.io/badge/Windows-Download_.exe-0078D4?style=for-the-badge&logo=windows&logoColor=white" alt="Windows" />
  </a>
  <br />
  <sub>May trigger SmartScreen — click "More info" → "Run anyway"</sub>
</td>
<td align="center">
  <a href="https://github.com/777genius/agent-teams-ai/releases/latest/download/Agent.Teams.AI.AppImage">
    <img src="https://img.shields.io/badge/Linux-Download_.AppImage-FCC624?style=for-the-badge&logo=linux&logoColor=black" alt="Linux AppImage" />
  </a>
  <br />
  <a href="https://github.com/777genius/agent-teams-ai/releases/latest/download/agent-teams-ai-amd64.deb">
    <img src="https://img.shields.io/badge/.deb-E95420?style=flat-square&logo=ubuntu&logoColor=white" alt=".deb" />
  </a>&nbsp;
  <a href="https://github.com/777genius/agent-teams-ai/releases/latest/download/agent-teams-ai-x86_64.rpm">
    <img src="https://img.shields.io/badge/.rpm-294172?style=flat-square&logo=redhat&logoColor=white" alt=".rpm" />
  </a>&nbsp;
  <a href="https://github.com/777genius/agent-teams-ai/releases/latest/download/agent-teams-ai.pacman">
    <img src="https://img.shields.io/badge/.pacman-1793D1?style=flat-square&logo=archlinux&logoColor=white" alt=".pacman" />
  </a>
</td>
</tr>
</table>

## Table of contents

- [Installation](#installation)
- [Table of contents](#table-of-contents)
- [What is this](#what-is-this)
- [Comparison](#comparison)
- [Quick start](#quick-start)
- [FAQ](#faq)
- [Development](#development)
  - [Developer architecture docs](#developer-architecture-docs)
- [Tech stack](#tech-stack)
  - [Debug teammate runtimes](#debug-teammate-runtimes)
  - [Build for distribution](#build-for-distribution)
  - [Scripts](#scripts)
- [Roadmap](#roadmap)
- [Contributing](#contributing)
- [Security](#security)
- [License](#license)

## What is this

An orchestration layer for AI agent teams across Claude, Codex, and OpenCode.

- **Claude + Codex + OpenCode orchestration** — start with a free model with no auth immediately, or auto-detect available Claude/Codex/OpenCode runtimes and use the provider access you already have - subscriptions or API keys
- **Assemble your team** — create agent teams with different roles that work autonomously in parallel
- **Agents talk to each other** — they communicate, create and manage their own tasks, review, leave comments
- **Cross-team communication** — agents can fully communicate across different teams; you can configure or prompt them to collaborate and message each other between teams
- **Sit back and watch** — tasks change status on the kanban board while agents handle everything on their own
- **Review changes like in Cursor** — see what code each task changed, then approve, reject, or comment
- **Built-in review workflow** — easily see how agents review each other's tasks to make sure everything went exactly as planned
- **Task-specific logs and messages** — clearly see agent/runtime logs (tools), actions and messages in isolation for each individual task, making it easy to trace what happened for any assignment
- **Live process section** — see which agents are running processes and open URLs directly in the browser
- **Stay in control** — send a direct message to any agent, drop a comment on a task, or pick a quick action right on the kanban card whenever you want to clarify something or add new work
- **Flexible autonomy** — let agents run fully autonomous, or review and approve each action one by one (you'll get a notification) — configure the level of control that fits your security needs
- **Solo mode** — one-member team: a single agent that creates its own tasks and shows live progress. Saves tokens; can expand to a full team anytime

<details>
<summary><strong>More features</strong></summary>

- **Task creation with attachments** — send a message to the team lead with any attached images. The lead will automatically create a fully described task and attach your files directly to the task for complete context.

- **Auto-resume after rate limits** — when the lead hits a Claude rate limit and the reset time is known, the app can automatically nudge the lead to continue once the cooldown has passed

- **Deep session analysis** — detailed breakdown of what happened in each agent session: bash commands, reasoning, subprocesses

- **Smart task-to-log/changes matching** — automatically links session logs/changes to specific tasks

- **Advanced context monitoring system** — comprehensive breakdown of what consumes tokens at every step: user messages, Claude.md instructions, tool outputs, thinking text, and team coordination. Token usage, percentage of context window, and session cost are displayed for each category, with detailed views by category or size.

- **Recent tasks across projects** — browse the latest completed tasks from all your projects in one place

- **Zero-setup onboarding** — start with the free model with no auth, then connect paid/account providers only when you need them

- **Built-in code editor** — edit project files with Git support without leaving the app

- **Branch strategy** — choose via prompt: single branch or git worktree per agent

- **Team member stats** — global performance statistics per member

- **Attach code context** — reference files or snippets in messages, like in Cursor. You can also mention tasks using `#task-id`, or refer to another team with `@team-name` in your messages.

- **Notification system** — configurable alerts when tasks complete, agents need your response, new comments arrive, or errors occur

- **MCP integration** — supports the built-in `mcp-server` (see [mcp-server folder](./mcp-server)) for integrating external tools and extensible agent plugins out of the box

- **Post-compact context recovery** — when the active runtime compacts its context, the app restores the key team-management instructions so kanban/task-board coordination stays consistent and important operational context is not lost

- **Task context is preserved** — thanks to task descriptions, comments, and attachments, all essential information about each task remains available for ongoing work and future reference

- **Workflow history** — see the full timeline of each task: when and how its status changed, which agents were involved, and every action that led to the current state

</details>

## Comparison

| Feature | Agent Teams | Gastown | Paperclip | Cursor | Claude Code CLI |
|---|---|---|---|---|---|
| **Cross-team communication** | ✅ Messages between separate teams | ⚠️ Coordination across groups | ⚠️ Company-scoped org work | N/A | ❌ |
| **Agent-to-agent messaging** | ✅ Native real-time mailbox | ✅ Mailboxes + handoffs | ⚠️ Comments + @mentions | ❌ | ✅ Team mailbox, no UI |
| **Linked tasks** | ✅ Tasks can link to and block each other | ⚠️ Task deps + grouped work | ✅ Goals, parent tasks, blockers | ❌ | ✅ Shared task list |
| **Session analysis** | ✅ Task logs + token usage | ⚠️ Session recall, feed, metrics | ⚠️ Run transcripts + cost audit | ❌ | ⚠️ Usage command, no UI |
| **Task attachments** | ✅ Auto-attach, agents read & attach files | ❌ Not task-level | ✅ Docs, attachments, work products | ⚠️ Chat session only | ⚠️ Chat images only |
| **Hunk-level review** | ✅ Accept / reject individual hunks | ❌ | ❌ Bring your own review | ✅ | ❌ |
| **Built-in code editor** | ✅ With Git support | ❌ | ❌ Control plane, not editor | ✅ Full IDE | ❌ |
| **Full autonomy** | ✅ Agents plan, assign, work, and review | ✅ Coordinator, grouped work, recovery | ✅ Wake-up runs + governance | ⚠️ Background agents, not teams | ✅ Experimental CLI teams |
| **Task dependencies** | ✅ Tasks wait for blockers automatically | ✅ Dependency waves | ✅ Blockers + execution locks | ❌ | ✅ Team task deps, no UI |
| **Review workflow** | ✅ Agents review each other + human review UI | ⚠️ Merge queue | ✅ Approvals + governance | ⚠️ PR/BugBot only | ✅ Team review, no UI |
| **Zero setup** | ✅ Guided runtime setup | ❌ Manual CLI stack | ⚠️ `npx` + local database | ✅ | ⚠️ CLI + env flag |
| **Kanban board** | ✅ 5 columns, real-time | ❌ Dashboard, not Kanban | ✅ 7 columns, drag-and-drop | ❌ | ❌ |
| **Execution logs** | ✅ Tool calls, reasoning, timeline | ⚠️ Feed, metrics, dashboard | ✅ Run transcripts + audit log | ⚠️ Agent chat + terminal | ❌ |
| **Live processes** | ✅ View, stop, open URLs in browser | ⚠️ Agent health dashboard | ⚠️ Manual services + previews | ⚠️ Native terminal only | ❌ |
| **CPU/RAM per teammate** | ✅ See CPU/RAM history for each live teammate | ⚠️ Shows activity/health, not CPU/RAM | ⚠️ Shows run status/cost, not CPU/RAM | ❌ Remote agent/terminal only | ❌ |
| **Per-task code review** | ✅ Accept / reject / comment | ⚠️ Merge queue, no diff UI | ⚠️ PR/work products, no inline diff | ✅ BugBot on PRs | ❌ |
| **Flexible autonomy** | ✅ Per-action approvals + notifications | ✅ Gates, escalation, recovery | ✅ Board approvals, pause, terminate | ⚠️ Background agents auto-run commands | ✅ Permissions + hooks |
| **Git worktree isolation** | ✅ Optional | ✅ Core primitive | ✅ Worktrees / branches | ⚠️ Background branches/VMs | ⚠️ Manual worktrees |
| **Mixed AI teammates** | ✅ Claude, Codex, and OpenCode in one team | ✅ Many providers, terminal-first | ✅ Bring your own agents/runtimes | ⚠️ Multi-model agents, no shared team | ⚠️ Claude-only experimental teams |
| **Live team map** | ✅ Map of teammates, tasks, blockers, handoffs, activity, logs | ⚠️ Agent tree + feed panels | ⚠️ Org chart/status, not a task/log map | ❌ | ❌ |
| **Live teammates** | ✅ Watch teammates work and message them directly | ⚠️ Terminal-based agent sessions | ⚠️ Agents wake up for runs, then sleep | ⚠️ Background agents per task | ⚠️ CLI teams, no desktop view |
| **Team workspace** | ✅ Tasks, logs, Kanban, review, and teammates in one app | ⚠️ Mail/feed/dashboard across tools | ⚠️ Board + transcripts, less live teammate view | ⚠️ IDE chats/tasks, not team view | ❌ No desktop UI |
| **Teammate launch status** | ✅ Know who started, who is stuck, and who replied | ⚠️ Session health, less clear message status | ⚠️ Run status, not live teammate status | ❌ | ⚠️ CLI mailbox, no visual status |
| **Org chart / governance** | ⚠️ Roles + approvals, no org chart | ⚠️ Roles + escalation | ✅ Org chart + board governance | ⚠️ Team admin only | ❌ |
| **Budget controls** | ⚠️ Cost/token visibility, no hard caps | ⚠️ Cost tiers + digest, no hard caps | ✅ Per-agent budgets + hard stops | ⚠️ Usage + BG spend limits | ⚠️ `/usage` + workspace limits |
| **Price** | **Free OSS UI + free model with no auth**, paid providers optional | Free OSS, runtime plans needed | Free OSS, self-hosted + infra | Free + paid usage | Claude plan or API usage |

Fact sources checked on May 18, 2026: [detailed research notes](docs/research/gastown-paperclip-comparison-2026-05-16.md), [Gastown README](https://github.com/gastownhall/gastown), [Gastown provider guide](https://github.com/gastownhall/gastown/blob/main/docs/agent-provider-integration.md), [Gastown scheduler](https://github.com/gastownhall/gastown/blob/main/docs/design/scheduler.md), [Gastown dashboard source](https://github.com/gastownhall/gastown/blob/main/internal/web/templates/convoy.html), [Gastown release](https://github.com/gastownhall/gastown/releases/tag/v1.1.0), [Paperclip README](https://github.com/paperclipai/paperclip), [Paperclip adapters](https://github.com/paperclipai/paperclip/blob/master/docs/adapters/overview.md), [Paperclip heartbeat protocol](https://github.com/paperclipai/paperclip/blob/master/docs/guides/agent-developer/heartbeat-protocol.md), [Paperclip org chart](https://paperclip.inc/docs/guides/board-operator/org-structure/), [Paperclip OrgChart source](https://github.com/paperclipai/paperclip/blob/master/ui/src/pages/OrgChart.tsx), [Paperclip budgets](https://github.com/paperclipai/paperclip/blob/master/docs/guides/board-operator/costs-and-budgets.md), [Paperclip runtime services](https://github.com/paperclipai/paperclip/blob/master/docs/guides/board-operator/execution-workspaces-and-runtime-services.md), [Paperclip Kanban source](https://github.com/paperclipai/paperclip/blob/master/ui/src/components/KanbanBoard.tsx), [Paperclip work products](https://github.com/paperclipai/paperclip/blob/master/packages/shared/src/validators/work-product.ts), [Paperclip release](https://github.com/paperclipai/paperclip/releases/tag/v2026.517.0), [Cursor Background Agents](https://docs.cursor.com/en/background-agents), [Cursor Diffs & Review](https://docs.cursor.com/en/agent/review), [Cursor Bugbot](https://docs.cursor.com/en/bugbot), [Cursor pricing](https://docs.cursor.com/en/account/usage), [Claude Code agent teams](https://code.claude.com/docs/en/agent-teams), [Claude Code subagents](https://code.claude.com/docs/en/sub-agents), [Claude Code workflows](https://code.claude.com/docs/en/common-workflows), [Claude Code costs](https://code.claude.com/docs/en/costs), [Claude pricing](https://claude.com/pricing).

---

## Quick start

1. **Download** the app for your platform (see [Installation](#installation))
2. **Launch the desktop app** - start with the free model with no auth, or let the setup wizard detect runtimes and guide provider authentication
3. **Create a team** — Pick a project, define roles, write a provisioning prompt
4. **Watch** — Agents spawn, create tasks, and work. You see it all on the kanban board

Use the desktop app as the primary product. The browser/web path is not needed for normal use and does not provide the full desktop runtime, IPC, terminal, provider auth, or team lifecycle behavior.


---

## FAQ

<details>
<summary><strong>Do I need to install a runtime before using this app?</strong></summary>
<br />
No. You can start with the free model with no auth right away. If you want Claude, Codex, OpenCode/OpenRouter, or other provider-backed models, the app guides runtime detection/setup and provider authentication from the UI.
</details>

<details>
<summary><strong>Does it read or upload my code?</strong></summary>
<br />
The app is not a cloud code-sync service. It reads local runtime/session data to power the UI, and your project stays on your machine unless you choose a provider/runtime path that sends data to that provider. In `multimodel` mode, startup may also perform runtime access and capability checks before launch.
</details>

<details>
<summary><strong>Can agents communicate with each other?</strong></summary>
<br />
Yes. Agents send direct messages, create shared tasks, and leave comments - all coordinated by the app's own orchestration layer.
</details>

<details>
<summary><strong>Is it free?</strong></summary>
<br />
Yes. The app is free and open source, and you can start with a free model with no auth - no registration, API keys, or credit card. If you want more models, connect the provider access you already have, such as Claude, Codex, OpenCode/OpenRouter, or other supported runtimes.
</details>

<details>
<summary><strong>Can I review code changes before they're applied?</strong></summary>
<br />
Yes. Every task shows a full diff view where you can accept, reject, or comment on individual code hunks — similar to Cursor's review flow.
</details>

<details>
<summary><strong>What happens if an agent gets stuck?</strong></summary>
<br />
Send a direct message to course-correct, or stop and restart from the process dashboard. If an agent needs your input, you'll get a notification and the task will show a distinct badge on the board.
</details>

<details>
<summary><strong>Does it support multiple projects and teams?</strong></summary>
<br />
Yes. Run multiple teams in one project or across different projects, even simultaneously. To avoid Git conflicts, ask agents to use git worktree in your provisioning prompt.
</details>

---

## Development

### Developer architecture docs

For feature architecture and implementation guidance:

- Canonical standard - [docs/FEATURE_ARCHITECTURE_STANDARD.md](docs/FEATURE_ARCHITECTURE_STANDARD.md)
- Repo working instructions - [CLAUDE.md](CLAUDE.md)
- Feature root guidance - [src/features/README.md](src/features/README.md)
- Reference implementation - `src/features/recent-projects`

## Tech stack

Electron 40, React 19, TypeScript 5, Tailwind CSS 3, Zustand 4. Data from `~/.claude/` (session logs, todos, tasks). The desktop app works with local runtime/session state, while some runtime modes may also use provider or startup capability services when required.

<details>
<summary><strong>Build from source</strong></summary>

<br />

**Prerequisites:** Node.js 20+, pnpm 10+

```bash
git clone https://github.com/777genius/agent-teams-ai.git
cd agent-teams-ai
pnpm install
pnpm dev
```

`pnpm dev` starts the desktop Electron app. Do not start a browser/web dev server for normal development; that path is limited and is not the supported way to run agent teams locally.

Use `pnpm dev:mcp` when you want an MCP browser/debugging tool to attach to the current
Electron renderer through the local Chrome DevTools Protocol endpoint on `127.0.0.1:9222`.

The desktop app auto-discovers Claude Code projects from `~/.claude/`.

### Debug teammate runtimes

Development launches use the app-managed process backend for teammates by default. To inspect
teammates in `tmux` panes while debugging, start the desktop app with:

```bash
CLAUDE_TEAM_TEAMMATE_MODE=tmux pnpm dev
```

The same override is available per launch from custom CLI args with
`--teammate-mode tmux`. Use this as an operator/debug mode; the default process backend provides
stronger app-owned lifecycle, diagnostics, and cleanup for normal team launches.

### Build for distribution

```bash
pnpm dist:mac:arm64  # macOS Apple Silicon (.dmg)
pnpm dist:mac:x64    # macOS Intel (.dmg)
pnpm dist:win        # Windows (.exe)
pnpm dist:linux      # Linux (AppImage/.deb/.rpm/.pacman)
pnpm dist            # Current platform
```

Distribution scripts run the production build and stage the bundled multimodel runtime from
`runtime.lock.json` before packaging. Use `pnpm clean:runtime` to remove staged runtime files after
local packaging.

### Scripts

| Command                       | Description                                                                  |
| ----------------------------- | ---------------------------------------------------------------------------- |
| `pnpm dev`                    | Desktop app development with hot reload                                      |
| `pnpm dev:mcp`                | Desktop app development with hot reload and local CDP debugging on port 9222 |
| `pnpm build`                  | Production build                                                             |
| `pnpm typecheck`              | TypeScript type checking                                                     |
| `pnpm lint`                   | Lint (no auto-fix)                                                           |
| `pnpm lint:fix`               | Lint and auto-fix                                                            |
| `pnpm format`                 | Format code with Prettier                                                    |
| `pnpm test`                   | Run all tests                                                                |
| `pnpm test:watch`             | Watch mode                                                                   |
| `pnpm test:coverage`          | Coverage report                                                              |
| `pnpm test:coverage:critical` | Critical path coverage                                                       |
| `pnpm check`                  | Full quality gate (types + lint + test + build)                              |
| `pnpm fix`                    | Lint fix + format                                                            |
| `pnpm quality`                | Full check + format check + knip                                             |

</details>

---

## Roadmap

- [ ] Planning mode to organize agent plans before execution
- [ ] Visual workflow editor ([@xyflow/react](https://github.com/xyflow/xyflow)) for building and orchestrating agent pipelines with drag & drop
- [ ] Remote agent execution via SSH: launch and manage agent teams on remote machines over SSH (stream-json protocol over SSH channel, SFTP-based file monitoring for tasks/inboxes/config)
- [x] CLI runtime: Run not only on a local PC but in any headless/console environment (web UI), e.g. VPS, remote server, etc.
- [ ] 2 modes: current (agent teams), and a new mode: regular subagents (no communication between them)
- [ ] Curate what context each agent sees (files, docs, MCP servers, skills)
- [x] Slash commands
- [ ] Outgoing message queue — queue user messages while the lead (or agent) is busy; clear agent-busy status in the UI; flush to stdin or relay from inbox when idle (durable queue on disk for the lead inbox path)
- [ ] `createTasksBatch` — IPC/service API to create many team tasks in one call (playbooks, markdown checklist import, scripts); complements single `createTask`
- [ ] Command palette — extend Cmd/Ctrl+K beyond project/session search to runnable actions (quick commands, navigation shortcuts, team/task operations) in a keyboard-first flow
- [ ] Custom kanban columns
- [ ] Run terminal commands
- [x] Monitor agents processes/stats
- [ ] Reusable agents with SOUL.md
- [ ] Сommunicate via messenger
- [ ] SDK to programmatically launch agents

---

## Contributing

See [CONTRIBUTING.md](.github/CONTRIBUTING.md) for development guidelines. Please read our [Code of Conduct](.github/CODE_OF_CONDUCT.md).

## Security

IPC and standalone HTTP handlers validate IDs, paths, and payload shape at the boundary. Project editing and write operations are constrained to the selected project root, while read-only discovery also accesses local Claude data under `~/.claude/` and app-owned state paths when required. Path traversal and sensitive config/credential targets are blocked. See [SECURITY.md](.github/SECURITY.md) for details.

## License

[AGPL-3.0](LICENSE)
