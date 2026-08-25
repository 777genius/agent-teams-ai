# Security & Privacy

## Network Activity

Agent Teams does not upload project files, source code, prompt or message contents, or local session contents as product data.

Official Electron releases include limited pseudonymous telemetry. It is enabled by default and can be disabled at any time in **Settings > Privacy > Send anonymous telemetry**. The setting gates both telemetry providers:

- **Sentry** receives redacted crash, error, and sampled performance events. Default PII collection is disabled, sensitive keys and credential-like values are redacted, and integrations that can collect local context, console output, screenshots, or process details are removed.
- **PostHog** receives only explicitly defined product-usage events with coarse categories or buckets where applicable. Automatic event capture, page-view tracking, session replay, surveys, feature flags, and external dependency loading are disabled.

Telemetry uses a pseudonymous app installation identifier rather than an account name or email. Development and self-built packages without the build-time Sentry DSN and PostHog key do not send this telemetry.

| Network activity                       | When                                                 | Mode                       | User-controlled                          |
| -------------------------------------- | ---------------------------------------------------- | -------------------------- | ---------------------------------------- |
| GitHub Releases API (auto-updater)     | App launch                                           | Electron only              | Automatic; controlled by update settings |
| Sentry crash and performance telemetry | Telemetry enabled and an event occurs                | Official Electron releases | Yes; can be disabled in Privacy settings |
| PostHog coarse product-usage telemetry | Telemetry enabled and a defined product event occurs | Official Electron releases | Yes; can be disabled in Privacy settings |
| Agent provider CLI/API traffic         | A user launches or interacts with an agent runtime   | Runtime-dependent          | Yes                                      |
| SSH connections                        | Settings > SSH                                       | Electron only              | Yes                                      |
| HTTP server (`127.0.0.1` or `0.0.0.0`) | When enabled                                         | Both                       | Yes                                      |

### Standalone / Docker mode

In standalone mode (Docker or `node dist-standalone/index.cjs`), the Electron auto-updater, SSH features, and Electron Sentry integration are disabled. Self-built standalone packages without telemetry build keys do not send product telemetry. The HTTP server listens for incoming connections on the configured port.

## Data Handling

- Session and project content is read **locally**. Raw source code, prompts, messages, file contents, repository paths, and session contents are not intentionally included in Agent Teams telemetry.
- The app does not write to session files. Volume mounts in Docker use `:ro` (read-only) by default.
- Configuration is stored at `~/.claude/agent-teams-config.json` on the local filesystem.
- Agent runtimes such as Claude Code, Codex, or OpenCode may communicate with their configured providers when the user runs them. That traffic is controlled by the runtime and provider configuration, not collected or proxied by Agent Teams as telemetry.

## Docker Network Isolation

For maximum trust, run the Docker container with `--network none`:

```bash
docker build -t agent-teams-ai -f docker/Dockerfile .
docker run --network none -p 3456:3456 -v ~/.claude:/data/.claude:ro agent-teams-ai
```

Or with Docker Compose, uncomment `network_mode: "none"` in `docker/docker-compose.yml`.

## IPC & Input Validation

- Electron IPC and standalone HTTP handlers validate IDs, paths, and payloads at the boundary
- Project editing and write operations are constrained to the selected project root
- Read-only discovery may access local Claude data under `~/.claude/` and app-owned state paths when needed
- Path traversal attacks are blocked
- Sensitive config and credential-like paths are rejected or treated as protected targets

## Supported Versions

Only the latest release is supported with security fixes.

## Reporting a Vulnerability

Please report vulnerabilities privately and do not open public issues for undisclosed security problems.

Include:

- affected version/commit
- vulnerability description
- impact assessment
- reproduction steps or proof of concept

If you do not have a private contact path yet, open a minimal GitHub issue asking for a secure reporting channel without disclosing technical details.

## Disclosure Process

- We will acknowledge reports as quickly as possible.
- We will validate, triage severity, and prepare a fix.
- We will coordinate a release and publish advisories when appropriate.
