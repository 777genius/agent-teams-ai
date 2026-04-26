<p align="center">
  <a href="docs/screenshots/1.jpg"><img src="docs/screenshots/1.jpg" width="75" alt="Kanban Board" /></a>&nbsp;
  <a href="docs/screenshots/7.png"><img src="docs/screenshots/7.png" width="75" alt="Code Review" /></a>&nbsp;
  <a href="docs/screenshots/2.jpg"><img src="docs/screenshots/2.jpg" width="75" alt="Team View" /></a>&nbsp;
  <a href="docs/screenshots/8.png"><img src="docs/screenshots/8.png" width="75" alt="Task Detail" /></a>&nbsp;
  <img src="resources/icons/png/1024x1024.png" alt="Agent Teams" width="80" />&nbsp;
  <a href="docs/screenshots/9.png"><img src="docs/screenshots/9.png" width="75" alt="Execution Logs" /></a>&nbsp;
  <a href="docs/screenshots/3.jpg"><img src="docs/screenshots/3.png" width="75" alt="Agent Comments" /></a>&nbsp;
  <a href="docs/screenshots/4.png"><img src="docs/screenshots/4.png" width="75" alt="Create Team" /></a>&nbsp;
  <a href="docs/screenshots/6.png"><img src="docs/screenshots/6.png" width="65" alt="Settings" /></a>
</p>

<h1 align="center"><a href="https://777genius.github.io/claude_agent_teams_ui/">Agent Teams</a></h1>

<p align="center">
  <strong><code>You're the CTO, agents are your team. They handle tasks themselves, message each other, review each other. You just look at the kanban board and drink coffee.</code></strong>
</p>

<p align="center">
  <a href="https://github.com/777genius/claude_agent_teams_ui/releases/latest"><img src="https://img.shields.io/github/v/release/777genius/claude_agent_teams_ui?style=flat-square&label=version&color=blue" alt="Latest Release" /></a>&nbsp;
  <a href="https://github.com/777genius/claude_agent_teams_ui/actions/workflows/ci.yml"><img src="https://github.com/777genius/claude_agent_teams_ui/actions/workflows/ci.yml/badge.svg" alt="CI Status" /></a>&nbsp;
  <a href="https://discord.gg/qtqSZSyuEc"><img src="https://img.shields.io/badge/Discord-Join%20us-5865F2?style=flat-square&logo=discord&logoColor=white" alt="Discord" /></a>
</p>

<p align="center">
  <sub>Free desktop app for AI agent teams. Auto-detects Claude/Codex. Use the provider access you already have - subscriptions or API keys. Not just coding agents.</sub>
</p>

<img width="1304" height="820" alt="image" src="https://github.com/user-attachments/assets/dea53a01-68b3-4c36-bcf6-e4d1ad4cdb31" />

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
If you want the freshest version, clone the repo and run it from the `dev` branch.

<table align="center">
<tr>
<td align="center">
  <a href="https://github.com/777genius/claude_agent_teams_ui/releases/latest/download/Claude-Agent-Teams-UI-arm64.dmg">
    <img src="https://img.shields.io/badge/macOS_Apple_Silicon-.dmg-000000?style=for-the-badge&logo=apple&logoColor=white" alt="macOS Apple Silicon" />
  </a>
  <br />
  <a href="https://github.com/777genius/claude_agent_teams_ui/releases/latest/download/Claude-Agent-Teams-UI-x64.dmg">
    <img src="https://img.shields.io/badge/macOS_Intel-.dmg-434343?style=for-the-badge&logo=apple&logoColor=white" alt="macOS Intel" />
  </a>
</td>
<td align="center">
  <a href="https://github.com/777genius/claude_agent_teams_ui/releases/latest/download/Claude-Agent-Teams-UI-Setup.exe">
    <img src="https://img.shields.io/badge/Windows-Download_.exe-0078D4?style=for-the-badge&logo=windows&logoColor=white" alt="Windows" />
  </a>
  <br />
  <sub>May trigger SmartScreen — click "More info" → "Run anyway"</sub>
</td>
<td align="center">
  <a href="https://github.com/777genius/claude_agent_teams_ui/releases/latest/download/Claude-Agent-Teams-UI.AppImage">
    <img src="https://img.shields.io/badge/Linux-Download_.AppImage-FCC624?style=for-the-badge&logo=linux&logoColor=black" alt="Linux AppImage" />
  </a>
  <br />
  <a href="https://github.com/777genius/claude_agent_teams_ui/releases/latest/download/Claude-Agent-Teams-UI-amd64.deb">
    <img src="https://img.shields.io/badge/.deb-E95420?style=flat-square&logo=ubuntu&logoColor=white" alt=".deb" />
  </a>&nbsp;
  <a href="https://github.com/777genius/claude_agent_teams_ui/releases/latest/download/Claude-Agent-Teams-UI-x86_64.rpm">
    <img src="https://img.shields.io/badge/.rpm-294172?style=flat-square&logo=redhat&logoColor=white" alt=".rpm" />
  </a>&nbsp;
  <a href="https://github.com/777genius/claude_agent_teams_ui/releases/latest/download/Claude-Agent-Teams-UI.pacman">
    <img src="https://img.shields.io/badge/.pacman-1793D1?style=flat-square&logo=archlinux&logoColor=white" alt=".pacman" />
  </a>
</td>
</tr>
</table>

## Table of contents

- [Installation](#installation)
- [Table of contents](#table-of-contents)
- [What is this](#what-is-this)
- [Developer architecture docs](#developer-architecture-docs)
- [Comparison](#comparison)
- [Quick start](#quick-start)
- [FAQ](#faq)
- [Development](#development)
- [Tech stack](#tech-stack)
  - [Build for distribution](#build-for-distribution)
  - [Scripts](#scripts)
- [Roadmap](#roadmap)
- [Contributing](#contributing)
- [Security](#security)
- [License](#license)

## What is this

An orchestration layer for AI agent teams across Claude and Codex.

- **Claude + Codex orchestration** — auto-detect available Claude/Codex runtimes and use the provider access you already have - subscriptions or API keys
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

- **Zero-setup onboarding** — built-in runtime detection and provider authentication

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

## Developer architecture docs

For feature architecture and implementation guidance:

- Canonical standard - [docs/FEATURE_ARCHITECTURE_STANDARD.md](docs/FEATURE_ARCHITECTURE_STANDARD.md)
- Repo working instructions - [CLAUDE.md](CLAUDE.md)
- Feature root guidance - [src/features/README.md](src/features/README.md)
- Reference implementation - `src/features/recent-projects`

## Comparison

| Feature | Agent Teams | Vibe Kanban | Aperant | Cursor | Claude Code CLI |
|---|---|---|---|---|---|
| **Cross-team communication** | ✅ | ❌ | ❌ | — | ❌ |
| **Agent-to-agent messaging** | ✅ Native real-time mailbox | ❌ Agents are independent | ❌ Fixed pipeline | ❌ | ✅⚠️ Built-in (no UI) |
| **Linked tasks** | ✅ Cross-references in messages | ⚠️ Subtasks only | ❌ | ❌ | ❌ |
| **Session analysis** | ✅ 6-category token tracking | ❌ | ⚠️ Execution logs | ❌ | ❌ |
| **Task attachments** | ✅ Auto-attach, agents read & attach files | ❌ | ✅ Images + files | ⚠️ Chat session only | ❌ |
| **Hunk-level review** | ✅ Accept / reject individual hunks | ❌ | ❌ | ✅ | ❌ |
| **Built-in code editor** | ✅ With Git support | ❌ | ❌ | ✅ Full IDE | ❌ |
| **Full autonomy** | ✅ Agents create, assign, review tasks end-to-end | ❌ Human manages tasks | ❌ Fixed pipeline | ⚠️ Isolated tasks only | ✅⚠️ (no UI) |
| **Task dependencies (blocked by)** | ✅ Guaranteed ordering | ❌ | ⚠️ Within plan only | ❌ | ✅⚠️ (no UI, no notifications) |
| **Review workflow** | ✅ Agents review each other | ❌ | ⚠️ Auto QA pipeline | ❌ | ✅⚠️ (no UI) |
| **Zero setup** | ✅ | ❌ Config required | ❌ Config required | ✅ | ⚠️ CLI install required |
| **Kanban board** | ✅ 5 columns, real-time | ✅ | ✅ 6 columns (pipeline) | ❌ | ❌ |
| **Execution log viewer** | ✅ Tool calls, reasoning, timeline | ❌ | ✅ Phase-based logs | ✅ | ❌ |
| **Live processes** | ✅ View, stop, open URLs in browser | ❌ | ❌ | ✅ | ❌ |
| **Per-task code review** | ✅ Accept / reject / comment | ⚠️ PR-level only | ⚠️ File-level only | ✅ BugBot on PRs | ❌ |
| **Flexible autonomy** | ✅ Granular settings, per-action approval, notifications | ❌ | ⚠️ Plan approval only | ✅ | ✅ |
| **Git worktree isolation** | ✅ Optional | ⚠️ Mandatory | ⚠️ Mandatory | ✅ | ✅ |
| **Multi-agent backend** | ✅ Codex, Claude, and 75+ providers | ✅ 6+ agents | ✅ 11 providers | ✅ Multi-model | — |
| **Price** | **Free** | Free / $30 user/mo | Free | $0–$200/mo | Provider subscription |

---

## Quick start

1. **Download** the app for your platform (see [Installation](#installation))
2. **Launch** — On first run, the setup wizard will detect the runtime and guide provider authentication
3. **Create a team** — Pick a project, define roles, write a provisioning prompt
4. **Watch** — Agents spawn, create tasks, and work. You see it all on the kanban board


---

## FAQ

<details>
<summary><strong>Do I need to install a runtime before using this app?</strong></summary>
<br />
No. The app guides runtime detection/setup and provider authentication from the UI - just launch and follow the setup wizard.
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
Yes, free and open source. The app has no paid tier of its own. To run agents, you only need access to a supported provider/runtime, such as Anthropic or Codex.
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

## Tech stack

Electron 40, React 19, TypeScript 5, Tailwind CSS 3, Zustand 4. Data from `~/.claude/` (session logs, todos, tasks). The desktop app works with local runtime/session state, while some runtime modes may also use provider or startup capability services when required.

<details>
<summary><strong>Build from source</strong></summary>

<br />

**Prerequisites:** Node.js 20+, pnpm 10+

```bash
git clone https://github.com/777genius/claude_agent_teams_ui.git
cd claude_agent_teams_ui
pnpm install
pnpm dev
```

The app auto-discovers Claude Code projects from `~/.claude/`.

### Build for distribution

```bash
pnpm dist:mac:arm64  # macOS Apple Silicon (.dmg)
pnpm dist:mac:x64    # macOS Intel (.dmg)
pnpm dist:win        # Windows (.exe)
pnpm dist:linux      # Linux (AppImage/.deb/.rpm/.pacman)
pnpm dist            # macOS + Windows + Linux
```

### Scripts

| Command | Description |
|---------|-------------|
| `pnpm dev` | Development with hot reload |
| `pnpm build` | Production build |
| `pnpm typecheck` | TypeScript type checking |
| `pnpm lint` | Lint (no auto-fix) |
| `pnpm lint:fix` | Lint and auto-fix |
| `pnpm format` | Format code with Prettier |
| `pnpm test` | Run all tests |
| `pnpm test:watch` | Watch mode |
| `pnpm test:coverage` | Coverage report |
| `pnpm test:coverage:critical` | Critical path coverage |
| `pnpm check` | Full quality gate (types + lint + test + build) |
| `pnpm fix` | Lint fix + format |
| `pnpm quality` | Full check + format check + knip |

</details>

---

## Roadmap

- [ ] Planning mode to organize agent plans before execution
- [ ] Visual workflow editor ([@xyflow/react](https://github.com/xyflow/xyflow)) for building and orchestrating agent pipelines with drag & drop
- [ ] Support more models/providers (including local) e.g OpenCode (with many providers)
- [ ] Remote agent execution via SSH: launch and manage agent teams on remote machines over SSH (stream-json protocol over SSH channel, SFTP-based file monitoring for tasks/inboxes/config)
- [ ] CLI runtime: Run not only on a local PC but in any headless/console environment (web UI), e.g. VPS, remote server, etc.
- [ ] 2 modes: current (agent teams), and a new mode: regular subagents (no communication between them)
- [ ] Curate what context each agent sees (files, docs, MCP servers, skills)
- [ ] Slash commands
- [ ] Outgoing message queue — queue user messages while the lead (or agent) is busy; clear agent-busy status in the UI; flush to stdin or relay from inbox when idle (durable queue on disk for the lead inbox path)
- [ ] `createTasksBatch` — IPC/service API to create many team tasks in one call (playbooks, markdown checklist import, scripts); complements single `createTask`
- [ ] Command palette — extend Cmd/Ctrl+K beyond project/session search to runnable actions (quick commands, navigation shortcuts, team/task operations) in a keyboard-first flow
- [ ] Custom kanban columns
- [ ] Run terminal commands
- [ ] Monitor agents processes/stats
- [ ] Reusable agents with SOUL.md
- [ ] Сommunicate via messenger

---

## Contributing

See [CONTRIBUTING.md](.github/CONTRIBUTING.md) for development guidelines. Please read our [Code of Conduct](.github/CODE_OF_CONDUCT.md).

## Security

IPC and standalone HTTP handlers validate IDs, paths, and payload shape at the boundary. Project editing and write operations are constrained to the selected project root, while read-only discovery also accesses local Claude data under `~/.claude/` and app-owned state paths when required. Path traversal and sensitive config/credential targets are blocked. See [SECURITY.md](.github/SECURITY.md) for details.

## License

[AGPL-3.0](LICENSE)
