<p align="center">
  <img src="resources/icons/png/1024x1024.png" alt="Claude Agent Teams UI" width="120" />
</p>

<h1 align="center">Claude Agent Teams UI</h1>

<p align="center">
  <strong><code>Terminal tells you nothing. This shows you everything.</code></strong>
  <br />
  You're the CTO, agents are your team. They handle tasks themselves, message each other, review each other's code. You just look at the kanban board and drink coffee.
</p>

<p align="center">
  <a href="https://github.com/777genius/claude_agent_teams_ui/releases/latest"><img src="https://img.shields.io/github/v/release/777genius/claude_agent_teams_ui?style=flat-square&label=version&color=blue" alt="Latest Release" /></a>&nbsp;
  <a href="https://github.com/777genius/claude_agent_teams_ui/actions/workflows/ci.yml"><img src="https://github.com/777genius/claude_agent_teams_ui/actions/workflows/ci.yml/badge.svg" alt="CI Status" /></a>&nbsp;
  <a href="https://github.com/777genius/claude_agent_teams_ui/releases"><img src="https://img.shields.io/github/downloads/777genius/claude_agent_teams_ui/total?style=flat-square&color=green" alt="Downloads" /></a>&nbsp;
  <img src="https://img.shields.io/badge/platform-macOS%20(Apple%20Silicon%20%2B%20Intel)%20%7C%20Linux%20%7C%20Windows%20%7C%20Docker-lightgrey?style=flat-square" alt="Platform" />
</p>

<br />

<p align="center">
  <a href="https://github.com/777genius/claude_agent_teams_ui/releases/latest">
    <img src="https://img.shields.io/badge/macOS-Download-black?logo=apple&logoColor=white&style=flat" alt="Download for macOS" height="30" />
  </a>&nbsp;&nbsp;
  <a href="https://github.com/777genius/claude_agent_teams_ui/releases/latest">
    <img src="https://img.shields.io/badge/Linux-Download-FCC624?logo=linux&logoColor=black&style=flat" alt="Download for Linux" height="30" />
  </a>&nbsp;&nbsp;
  <a href="https://github.com/777genius/claude_agent_teams_ui/releases/latest">
    <img src="https://img.shields.io/badge/Windows-Download-0078D4?logo=windows&logoColor=white&style=flat" alt="Download for Windows" height="30" />
  </a>&nbsp;&nbsp;
  <a href="#docker--standalone-deployment">
    <img src="https://img.shields.io/badge/Docker-Deploy-2496ED?logo=docker&logoColor=white&style=flat" alt="Deploy with Docker" height="30" />
  </a>
</p>

<p align="center">
  <sub>100% free, open source. No API keys. No configuration. Just download, open, and see everything Claude Code did.</sub>
</p>

<br />

<!--
<p align="center">
  <video src="https://github.com/user-attachments/assets/2b420b2c-c4af-4d10-a679-c83269f8ee99">
    Your browser does not support the video tag.
  </video>
</p>

---
-->

## Installation

### Direct Download

| Platform | Download | Notes |
|----------|----------|-------|
| **macOS** (Apple Silicon) | [`.dmg`](https://github.com/777genius/claude_agent_teams_ui/releases/latest) | Download the `arm64` asset. Drag to Applications. On first launch: right-click → Open |
| **macOS** (Intel) | [`.dmg`](https://github.com/777genius/claude_agent_teams_ui/releases/latest) | Download the `x64` asset. Drag to Applications. On first launch: right-click → Open |
| **Linux** | [`.AppImage` / `.deb` / `.rpm` / `.pacman`](https://github.com/777genius/claude_agent_teams_ui/releases/latest) | Choose the package format for your distro (portable AppImage or native package manager format). |
| **Windows** | [`.exe`](https://github.com/777genius/claude_agent_teams_ui/releases/latest) | Standard installer. May trigger SmartScreen — click "More info" → "Run anyway" |
| **Docker** | `docker compose up` | Open `http://localhost:3456`. See [Docker / Standalone Deployment](#docker--standalone-deployment) for details. |

The app reads session logs from `~/.claude/` — the data is already on your machine. No setup, no API keys, no login.

---

## What the CLI Hides vs. What Claude Agent Teams UI Shows

| What you see in the terminal | What Claude Agent Teams UI shows you |
|------------------------------|-------------------------------|
| `Read 3 files` | Exact file paths, syntax-highlighted content with line numbers |
| `Searched for 1 pattern` | The regex pattern, every matching file, and the matched lines |
| `Edited 2 files` | Inline diffs with added/removed highlighting per file |
| A three-segment context bar | Per-turn token attribution across 7 categories — CLAUDE.md breakdown, skills, @-mentions, tool I/O, thinking, teams, user text — with compaction visualization showing how context fills, compresses, and refills |
| Subagent output interleaved with the main thread | Isolated execution trees per agent, expandable inline with their own metrics |
| Teammate messages buried in session logs | Color-coded teammate cards with name, message, and full team lifecycle visibility |
| Critical events mixed into normal output | Trigger-filtered notification inbox for `.env` access, payment-related file paths, execution errors, and high token usage |
| `--verbose` JSON dump | Structured, filterable, navigable interface — no noise |

---

## Docker / Standalone Deployment

Run Claude Agent Teams UI without Electron — in Docker, on a remote server, or anywhere Node.js runs.

### Quick Start (Docker Compose)

```bash
docker compose up
```

Open `http://localhost:3456` in your browser.

### Quick Start (Docker)

```bash
docker build -t claude-agent-teams-ui .
docker run -p 3456:3456 -v ~/.claude:/data/.claude:ro claude-agent-teams-ui
```

### Quick Start (Node.js)

```bash
pnpm install
pnpm standalone:build
node dist-standalone/index.cjs
```

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `CLAUDE_ROOT` | `~/.claude` | Path to the `.claude` data directory |
| `HOST` | `0.0.0.0` | Bind address |
| `PORT` | `3456` | Listen port |
| `CORS_ORIGIN` | `*` (standalone) | CORS origin policy (`*`, specific origin, or comma-separated list) |

### Notes

- **Real-time updates may be slower than Electron.** The Electron app uses native file system watchers with IPC for instant updates. The Docker/standalone server uses SSE (Server-Sent Events) over HTTP, which may introduce slight delays when sessions are actively being written to.
- **Custom Claude root path.** If your `.claude` directory is not at `~/.claude`, update the volume mount to point to the correct location:
  ```bash
  # Example: Claude root at /home/user/custom-claude-dir
  docker run -p 3456:3456 -v /home/user/custom-claude-dir:/data/.claude:ro claude-agent-teams-ui

  # Or with docker compose, set the CLAUDE_DIR env variable:
  CLAUDE_DIR=/home/user/custom-claude-dir docker compose up
  ```

### Security-Focused Deployment

The standalone server has **zero** outbound network calls. For maximum isolation:

```bash
docker run --network none -p 3456:3456 -v ~/.claude:/data/.claude:ro claude-agent-teams-ui
```

See [SECURITY.md](SECURITY.md) for a full audit of network activity.

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

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development guidelines. Please read our [Code of Conduct](CODE_OF_CONDUCT.md).

## Security

IPC handlers validate all inputs with strict path containment checks. File reads are constrained to the project root and `~/.claude`. Sensitive credential paths are blocked. See [SECURITY.md](SECURITY.md) for details.

## License

[MIT](LICENSE)
