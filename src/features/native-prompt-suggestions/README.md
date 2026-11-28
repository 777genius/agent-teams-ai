# Native next-prompt suggestions

Browser-safe feature slice, with only real owned layers:
\`contracts\`, pure \`core/domain\`, and passive \`renderer/ui\`.

Provider implementation lives in \`agent-teams-ai/old-provider-implementations\`
(PR #9) and owns native Claude SDK \`prompt_suggestion\` and Codex
\`thread/sample\`. The consumer's Host/Team/Runtime retains source-message
ownership, security checks, session/generation, model budget and publication
authority. This slice never starts a provider, resolves credentials, stores a
candidate durably or sends a message.

Existing MessageComposer and MentionableTextarea own the draft, focus,
attachment/mention/IME precedence and Send. This feature can only preview and
insert plain text into the existing controlled draft on explicit user action.
\`canDisplayNativeNextPrompt\` is a **second, UI-only safety check**; it
cannot substitute for Host authorization or real original-message proof.
Unsupported or stale candidates render nothing.

Consumer contract/UX plan: docs/plans/provider-migration/
native-prompt-suggestions-consumer-2026-11-14.md.

Security HOLD (HTTP): the existing `/api/events` stream is a process-wide,
unauthenticated broadcast. Main intentionally does **not** send native prompt
suggestion text to this SSE endpoint, even when a browser subscribes to the
feature channel. Electron IPC is scoped to the currently authorized renderer.
Do not re-enable HTTP publication until a per-owner/context authenticated SSE
route (including disconnect/revocation isolation) has actual E2E evidence.

## Setting and default (2026-11-17)

There is one setting per provider, `providerConnections.anthropic.nativeNextPromptSuggestionsEnabled` (Claude)
and `providerConnections.codex.nativeNextPromptSuggestionsEnabled`, shown as a switch on that provider's page
in **Provider Settings**. Both are **on by default**. A saved `false` is kept; a malformed saved value falls
back to the default. The former global `general` switch is gone. Earlier plan documents describing a
default-off opt-in are historical.

Main selects the enabled providers and hands them to the Host at start
(`AGENT_TEAMS_NATIVE_NEXT_PROMPT_PROVIDERS`, a comma separated subset of `claude,codex`, empty for none), so a
change applies to Host sessions started afterwards. Claude's suggestions are extra inference on the user's own
subscription, which is why each switch stays visible and can be turned off.

Claude only emits suggestions while its own account- and time-dependent rollout flag is on. For every Claude
member of an enabled provider the Host therefore adds `CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION=true` to the
process launch environment (`ClaudeMemberProvider`). Measured here: without it the same session offered
nothing for 20+ minutes, with it a suggestion arrived on the first turn. The profile's environment stays
captured and untouched; only the launch environment is extended.

The composer needs the member's Host id to show a row. It comes from the connection's own member bindings
(by name) and is refined by the roster read, so a failing `team.roster.read` no longer hides suggestions.
Suggestions are produced by the vendor, not by us: weaker models (Claude Haiku in our measurements) may never
offer one. See `scripts/e2e/native-prompt-suggestions-real/README.md`.
