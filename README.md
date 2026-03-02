<p align="center">
  <img src="resources/icons/png/1024x1024.png" alt="Claude Agent Teams UI" width="120" />
</p>

<h1 align="center">Claude Agent Teams UI</h1>

<p align="center">
  <strong><code>You're the CTO, agents are your team. They handle tasks themselves, message each other, review each other's code. You just look at the kanban board and drink coffee.</code></strong>
</p>

<p align="center">
  <a href="https://github.com/777genius/claude_agent_teams_ui/releases/latest"><img src="https://img.shields.io/github/v/release/777genius/claude_agent_teams_ui?style=flat-square&label=version&color=blue" alt="Latest Release" /></a>&nbsp;
  <a href="https://github.com/777genius/claude_agent_teams_ui/actions/workflows/ci.yml"><img src="https://github.com/777genius/claude_agent_teams_ui/actions/workflows/ci.yml/badge.svg" alt="CI Status" /></a>
</p>

<p align="center">
  <sub>100% free, open source. No API keys. No configuration.</sub>
</p>

<br />

## What is this

A new approach to task management with AI agents.

- **Assemble your team** — create agent teams with different roles that work autonomously in parallel
- **Agents talk to each other** — they communicate, create and manage their own tasks, and leave comments
- **Sit back and watch** — tasks change status on the kanban board while agents handle everything on their own
- **Review changes like in Cursor** — see what code each task changed, then approve, reject, or comment
- **Full tool visibility** — inspect exactly which tools an agent used to complete each task
- **Live process dashboard** — see which agents are running processes in dedicated sections (frontend, backend, etc.) and open URLs directly in the browser
- **Stay in control** — send a direct message to any agent or drop a comment on a task whenever you want to clarify something or add new work

<details>
<summary><strong>More features</strong></summary>

<br />

- **Recent tasks across projects** — browse the latest completed tasks from all your projects in one place
- **Deep session analysis** — detailed breakdown of what happened in each Claude session: bash commands, reasoning, subprocesses
- **Smart task-to-log matching** — automatically links Claude session logs to specific tasks based on status change timestamps, even when a task moves back and forth between states
- **Zero-setup onboarding** — built-in Claude Code installation and authentication, ready to go out of the box
- **Built-in code editor** — edit project files with Git support and other essential features without leaving the app
- **Branch strategy control** — choose via prompt whether all agents work on a single branch or each gets its own git worktree
- **Team member stats** — global performance statistics for every member of the team
- **Attach code context** — reference files or code snippets in your messages, just like in Cursor
- **Notification system** — configurable alerts when tasks complete, agents need attention, or errors occur

</details>

---

<!--
<p align="center">
  <video src="https://github.com/user-attachments/assets/2b420b2c-c4af-4d10-a679-c83269f8ee99">
    Your browser does not support the video tag.
  </video>
</p>

---
-->

## FAQ

<details>
<summary><strong>Do I need to install Claude Code before using this app?</strong></summary>
<br />
No. The app includes built-in installation and authentication — just launch and follow the setup wizard.
</details>

<details>
<summary><strong>Does it read or upload my code?</strong></summary>
<br />
No. Everything runs locally on your machine. The app reads Claude Code's session logs from <code>~/.claude/</code> — your source code is never sent anywhere.
</details>

<details>
<summary><strong>Can agents communicate with each other?</strong></summary>
<br />
Yes. Agents send direct messages, create shared tasks, and leave comments — all coordinated automatically through Claude Code's team protocol.
</details>

<details>
<summary><strong>Is it free?</strong></summary>
<br />
Yes, completely free and open source. The app itself requires no API keys or subscriptions. You only need a Claude Code plan from Anthropic to run agents.
</details>

<details>
<summary><strong>Can I review code changes before they're applied?</strong></summary>
<br />
Yes. Every task shows a full diff view where you can accept, reject, or comment on individual code hunks — similar to Cursor's review flow.
</details>

<details>
<summary><strong>What happens if an agent gets stuck?</strong></summary>
<br />
You can send a direct message to any agent at any time to course-correct, or stop and restart it from the process dashboard. If an agent needs your input, you'll get a notification and the task will be marked with a distinct badge on the board so you won't miss it.
</details>

<details>
<summary><strong>Can I use it just to view past sessions without running agents?</strong></summary>
<br />
Yes. The app works as a session viewer too — browse, search, and analyze any Claude Code session history.
</details>

<details>
<summary><strong>Does it support multiple projects and teams?</strong></summary>
<br />
Yes. Run multiple teams in one project or across different projects, even simultaneously. To avoid Git conflicts, ask agents to use git worktree in your provisioning prompt.
</details>

---

## Installation

No prerequisites — Claude Code can be installed and configured directly from the app.

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


---

## Development

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

The app auto-discovers your Claude Code projects from `~/.claude/`.

#### Build for Distribution

```bash
pnpm dist:mac:arm64  # macOS Apple Silicon (.dmg)
pnpm dist:mac:x64    # macOS Intel (.dmg)
pnpm dist:win        # Windows (.exe)
pnpm dist:linux      # Linux (AppImage/.deb/.rpm/.pacman)
pnpm dist            # macOS + Windows + Linux
```

#### Scripts

| Command | Description |
|---------|-------------|
| `pnpm dev` | Development with hot reload |
| `pnpm build` | Production build |
| `pnpm typecheck` | TypeScript type checking |
| `pnpm lint:fix` | Lint and auto-fix |
| `pnpm test` | Run all tests |
| `pnpm test:watch` | Watch mode |
| `pnpm test:coverage` | Coverage report |
| `pnpm check` | Full quality gate (types + lint + test + build) |

</details>

---

## TODO

- [ ] Run not only on a local PC but in any headless/console environment (web UI), e.g. VPS, remote server, etc.
- [ ] 2 modes: current (agent teams), and a new mode: regular subagents (no communication between them)

---

## Contributing

See [CONTRIBUTING.md](.github/CONTRIBUTING.md) for development guidelines. Please read our [Code of Conduct](.github/CODE_OF_CONDUCT.md).

## Security

IPC handlers validate all inputs with strict path containment checks. File reads are constrained to the project root and `~/.claude`. Sensitive credential paths are blocked. See [SECURITY.md](.github/SECURITY.md) for details.

## License

[MIT](LICENSE)
