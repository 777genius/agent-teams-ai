# Hosted Web: personal self-hosted deployment

One operator runs Agent Teams on their own dedicated server. Product (the web UI and API) runs in
Docker from `docker/docker-compose.yml`, profile `personal`. The Owner (hosted-control) and every
agent run on the host as one unprivileged agent user. `hostedctl` is the only launcher: it starts
the Owner, signs its admission for Product, and starts or stops Product as a pair with it.

## How the pair works

- Product accepts one Owner session exactly once. A Product restarted on its own would reconnect to
  a consumed session and stop, so Product has `restart: "no"` and `hostedctl` always restarts both.
- Every start allocates the next Owner generation and persists it before any process sees it.
  Product's high-water volume refuses any generation it has already seen.
- Stop order is always Product first, then the Owner lease (FD4). Any failure (Owner died, Product
  unhealthy for too long, start failed) stops both and exits non-zero; systemd then starts a fresh
  pair with the next generation.
- One Owner serves one team. Until you publish a team, the Owner serves an empty placeholder team.
  `hostedctl switch-team` restarts the pair with another published team.

Files and directories (defaults used below):

| Path                                                  | Owner, mode     | Content                                                     |
| ----------------------------------------------------- | --------------- | ----------------------------------------------------------- |
| `/etc/agent-teams/hosted-launcher.json`               | root, 0644      | launcher config                                             |
| `/etc/agent-teams/compose.env`                        | root, 0600      | image digests, domain, ports                                |
| `/etc/agent-teams/launcher/ed25519.pem`               | root, 0400      | launcher signing key (created once)                         |
| `/etc/agent-teams/launcher/provider.env`              | root, 0600      | optional OpenCode provider API keys                         |
| `~agent-teams/.config/agent-teams/claude-oauth-token` | agent, 0600     | Claude Code OAuth token (native lane)                       |
| `/etc/agent-teams/secrets`                            | root, 0700      | `HOSTED_SECRETS_DIR`: release pin, per-session trust anchor |
| `/var/lib/agent-teams-launcher`                       | root, 0700      | `state.json`, install records, session env                  |
| `/opt/agent-teams/src`                                | root            | Product checkout (compose files and `hostedctl`)            |
| `/opt/agent-teams/owner/<digest>`                     | root, read-only | extracted Owner artifact                                    |
| `/srv/agent-teams/claude`                             | agent, 0700     | Claude root shared with Product (teams, tasks)              |
| `/srv/agent-teams/workspaces/main`                    | agent, 0700     | the workspace agents work in                                |

## Requirements

- A dedicated Linux x64 VM. Do not use a shared worker host.
- Docker Engine with the Compose v2 plugin, Node.js 20 or newer, Python 3.10 or newer.
- An agent user with UID/GID `1000:1000`, a normal home directory, no sudo, and not in the
  `docker` group. Product's container runs as `1000:1000` too; see Risks.

```sh
sudo useradd --uid 1000 --user-group --create-home --shell /bin/bash agent-teams
sudo git clone https://github.com/777genius/agent-teams-ai.git /opt/agent-teams/src
```

## Configure

`/etc/agent-teams/hosted-launcher.json`:

```json
{
  "productRepo": "/opt/agent-teams/src",
  "stateDir": "/var/lib/agent-teams-launcher",
  "installRoot": "/opt/agent-teams",
  "runDir": "/run/agent-teams-launcher",
  "logDir": "/var/log/agent-teams-launcher",
  "launcherKeyFile": "/etc/agent-teams/launcher/ed25519.pem",
  "secretsDir": "/etc/agent-teams/secrets",
  "composeProject": "agent-teams-hosted",
  "composeEnvFile": "/etc/agent-teams/compose.env",
  "providerEnvFile": "/etc/agent-teams/launcher/provider.env",
  "agent": { "uid": 1000, "gid": 1000, "user": "agent-teams", "home": "/home/agent-teams",
             "runtimeDir": "/var/lib/agent-teams-runtime" },
  "claudeRoot": "/srv/agent-teams/claude",
  "workspaceRoot": "/srv/agent-teams/workspaces/main",
  "opencode": { "runtimeMode": "official-v1.18.32" }
}
```

`agent.runtimeDir` (optional, agent-owned, outside the Claude root) holds the Owner-managed
OpenCode state, cache and temp files, so the Owner does not share them with anything else that runs
as the agent user. Provider logins are still read from the agent's `HOME`.

`/etc/agent-teams/compose.env` holds only operator values. `hostedctl` refuses it if it sets a
launcher-owned key such as `CLAUDE_DIR`, `HOSTED_SECRETS_DIR` or the read bootstrap.

```sh
NODE_IMAGE_DIGEST=sha256:...
KEYCLOAK_IMAGE_DIGEST=sha256:...
CADDY_IMAGE_DIGEST=sha256:...
POSTGRES_IMAGE_DIGEST=sha256:...   # interpolated by Compose, unused by the personal profile
HOSTED_DOMAIN=agents.example.internal
HOSTED_PUBLIC_ORIGIN=https://agents.example.internal
```

`/etc/agent-teams/launcher/provider.env` (root, 0600) may contain only `ANTHROPIC_API_KEY` and
`OPENAI_API_KEY`. The Owner gets an explicit environment; nothing else from the launcher
environment reaches it or the agents.

Native Claude Code and Codex lanes are enabled by paths, never by secrets in the launcher config:

```json
"nativeProviders": {
  "anthropic": { "oauthTokenFile": "/home/agent-teams/.config/agent-teams/claude-oauth-token" },
  "codex": { "codexHome": "/home/agent-teams/.codex", "codexCliPath": "/usr/local/bin/codex" }
}
```

Either provider may be left out; leave the whole key out to keep native lanes unavailable. Paths
must be canonical and outside the Claude root. The token file must be owned by the agent user with
mode 0600.

For a custom OpenCode provider (for example a local OpenAI-compatible server), add
`"configFile": "/etc/agent-teams/launcher/opencode.json"` to `opencode`. The root-owned file is
passed to the Owner as `OPENCODE_CONFIG_CONTENT`.

## Install

```sh
H="node /opt/agent-teams/src/deploy/hosted-launcher/hostedctl.mjs"
sudo $H init                      # once: key, state, directories. Add --deployment-id to adopt
                                  # an existing personal database.
sudo $H install owner <registry>/<owner-image>@sha256:<digest> --version <semver>
sudo $H install product           # builds the Product image, extracts the team-tools MCP
sudo install -m 0644 /opt/agent-teams/src/deploy/hosted-launcher/systemd/agent-teams.slice \
  /opt/agent-teams/src/deploy/hosted-launcher/systemd/agent-teams-hosted.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now agent-teams-hosted.service
```

`install owner` needs the Owner image locally with that repo digest: pull it from a registry, or
build it and push it to a local registry (`docker run -d -p 127.0.0.1:5000:5000 registry:2`,
`docker build`, `docker push`), then pass the pushed `127.0.0.1:5000/...@sha256:` reference. It
extracts `/opt/owner` from the image, records the SHA-256 of every file and writes the release pin.
Every start re-hashes the files and refuses to run if anything changed. Re-run `install owner` and
`install product` to upgrade, then `systemctl restart agent-teams-hosted`.

## Provider logins

Install the provider CLIs system-wide (`/usr/local/bin`), then log in as the agent user. Logins
stay in the agent's home, never in the Claude root, which Product mounts.

- Claude Code: create a long-lived token with `claude setup-token` and write it to the
  `nativeProviders.anthropic.oauthTokenFile` path as the agent user (`umask 077`).
- Codex: `sudo -iu agent-teams codex login` (stored in `~agent-teams/.codex`).
- OpenCode: `sudo -iu agent-teams opencode auth login` (stored in
  `~agent-teams/.local/share/opencode`).

## First use

```sh
sudo docker exec agent-teams-hosted-controller node scripts/hosted-auth-cli.mjs pairing-code
```

Pair the browser, then grant yourself the workspace. `hostedctl status` prints `workspaceId`; the
user id is shown by `users list`.

```sh
sudo docker exec agent-teams-hosted-controller node scripts/hosted-auth-cli.mjs users list
sudo docker exec agent-teams-hosted-controller node scripts/hosted-auth-cli.mjs \
  workspaces grant <usr_...> <workspace_...>
```

Create and publish a team in the UI. `hostedctl status` lists it under `publishedTeams`. Then:

```sh
sudo $H switch-team <team_...>    # stops Product, starts Owner gen+1 for that team, starts Product
sudo $H switch-team --idle        # back to the placeholder team
```

## Operate

- `sudo $H status`: state, installed artifacts, active pair, Product health, published teams.
- `sudo journalctl -u agent-teams-hosted`: launcher events, one JSON line each.
- Owner logs: `/var/log/agent-teams-launcher/owner-g<generation>.log`.
- `sudo systemctl stop agent-teams-hosted` (or `sudo $H down`) stops Product, then the Owner.
- Pairing again (no active device, or after a host reset): stop the agents in the UI first, then
  restart the pair gracefully with `sudo systemctl restart agent-teams-hosted`, and only then read
  the new pairing code.

## Backup

Back up, together: `/var/lib/agent-teams-launcher` (the state holds the deployment id, workspace
id, owner authority and generation), `/etc/agent-teams` (launcher key, config, provider env),
the Claude root and the workspace. Product state is covered by
[hosted-web-stopped-stack-recovery.md](hosted-web-stopped-stack-recovery.md).

Losing `state.json` makes the deployment unusable with its existing Product volumes: Product pins
the owner authority forever and requires ever-increasing generations. If you restore an older
state, raise `ownerGeneration` above the last generation in the Owner logs before starting.

## Hardening checklist

- Dedicated VM; nothing else runs on it.
- Agent user: no sudo, not in the `docker` group, UID 1000.
- Block cloud metadata for the agent (persist the rule in your nftables config):

  ```sh
  nft add rule inet filter output meta skuid 1000 ip daddr 169.254.169.254 drop
  ```

- Expose Caddy only on a Tailscale or WireGuard address, or allowlist client IPs with ufw. Do not
  publish it to the whole internet.
- Secrets: `/etc/agent-teams` and `/var/lib/agent-teams-launcher` stay root-only (0700).
- Keep workspaces in their own directory; never point `workspaceRoot` at a home directory.
- Invariant: the agent's `HOME` is never the Claude root or inside it. Product mounts the Claude
  root, and provider logins in `HOME` must not reach that container (hostedctl refuses this).
- `agent-teams.slice` caps memory and tasks for the Owner and all agents; adjust `MemoryMax` and
  `TasksMax` to the VM.

## Risks accepted for this profile

- `trusted_process`: agents run as the agent user with that user's full rights. They can read
  anything the agent user can read, including provider logins and the workspace.
- Shared UID: Product's container and the Owner both run as UID 1000, because the socket and file
  custody checks require it. A compromised Product container process could therefore act on files
  the agent user owns in the mounted Claude root and workspace.
- The Claude Code token is readable by the agent user, and the native lead passes it to its
  teammates' environment.
- Pairing next to a live agent: a new first pairing code can exist while an adopted agent runtime is
  alive (scope lock decision 7). An agent gains nothing it does not already have as the agent user;
  still, stop the agents and restart the pair before pairing again.
