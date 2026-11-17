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
