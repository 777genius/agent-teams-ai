# Per-Member MCP Bootstrap Spike

Date: 2026-05-19

## Question

Can the app pass per-member MCP inheritance or allowlist settings through Claude Code native agent-team bootstrap?

## Findings

- The app currently starts native Claude-led teams with one lead CLI process and one generated `--mcp-config`. That generated config only contains the app-owned `agent-teams` server. User, project, and local MCP servers are inherited through `--setting-sources user,project,local`.
- Claude Code docs for agent teams state that teammates load MCP servers from project and user settings like regular sessions. They also state that subagent-definition `mcpServers` frontmatter is not applied when the definition runs as an agent-team teammate: https://code.claude.com/docs/en/agent-teams
- Claude Code docs for subagents support `mcpServers` for normal subagents and main sessions, but agent teams explicitly exclude that field on the teammate path: https://code.claude.com/docs/en/sub-agents
- Local Claude Code `2.1.119` supports `--mcp-config`, `--setting-sources`, and `--strict-mcp-config`. The public CLI reference documents those flags: https://code.claude.com/docs/en/cli-usage
- A local probe with `claude --bare --team-bootstrap-spec <spec>` on `2.1.119` exits with `error: unknown option '--team-bootstrap-spec'`, so the hidden app bootstrap path cannot be validated as a public CLI contract from the installed binary.

## Decision

Per-member MCP settings should be treated as a gated app feature until the native bootstrap contract is proven to apply them on initial spawn.

The safe implementation path is:

1. Persist `mcpPolicy` on members.
2. Surface the policy in the roster editor.
3. Apply the policy only on app-controlled teammate launches/restarts where the app owns the CLI args.
4. Keep initial native bootstrap behavior unchanged until the app either moves that path to app-managed teammate launch or detects a Claude Code capability that supports per-member MCP in bootstrap specs.

## Current Runtime Semantics

- `inheritLead`: keep existing behavior.
- `inheritScopes`: app-controlled teammate launches can narrow `--setting-sources`.
- `strictAllowlist`: app-controlled teammate launches generate a strict MCP config containing `agent-teams` plus selected server definitions.
- `appOnly`: app-controlled teammate launches generate a strict MCP config containing only `agent-teams`.

`agent-teams` must remain non-removable because it carries team messaging and task tooling.
