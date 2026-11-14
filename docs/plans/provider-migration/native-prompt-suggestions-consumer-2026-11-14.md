# Native next-message suggestions: Stage 1 Host + existing composer

Status: **dependent Draft implementation; NOT end-to-end qualified**  
Date: 2026-11-14  
Provider owner: [old-provider-implementations PR #9](https://github.com/agent-teams-ai/old-provider-implementations/pull/9)  
Frontend base: [#1186 frontend parity](https://github.com/777genius/agent-teams-ai/pull/1186) on top of Stage 1 Host [#982](https://github.com/777genius/agent-teams-ai/pull/982).

## Purpose and exact scope

Use the native Claude Agent SDK push message or Codex App Server \`thread/sample\` to offer **one editable next-message suggestion** to the human in the **existing** personal chat composer for **any** captured Claude or compatible Codex teammate, lead or peer, in same-provider and mixed teams.

The provider library owns native event decoding, sampling and bounded text. The captured Host and existing Team/Runtime owners own user-origin message proof, team identity, session generation, permissions and provider opt-in. This frontend feature owns only browser-safe DTOs, candidate freshness/keyboard policy and passive presentation. **Do not** move Team, Task, message, process custody or durable input authority into this feature.

Provider version baseline: PR #9 head \`74991c21a64f44a268bdb1d769b4a580b33a4853\`, [CI 43607379609](https://github.com/agent-teams-ai/old-provider-implementations/actions/runs/43607379609): Node 24/26, 513 source tests each + both packed consumer checks, source-fixture qualification only. Selected Stage 1 host Codex pin is 0.162.0; \`thread/sample\` requires separately qualified compatible version >=0.165. **No all-Codex rollout claim until this changes.**

## Existing code seams (reviewed on Stage1 and parity branches)

- \`packages/legacy-agent-host/src/composition/createRuntimeMemberProviderFactory.ts\` opens every captured member independently, selecting ClaudeMemberProvider, CodexMemberProvider or OpenCode. Never special-case lead; exact \`entry.binding\`, \`entry.profile\`, \`entry.delivery\`, and Host incarnation are already present.
- \`packages/legacy-agent-host/src/runtime/RuntimeOwner.ts\` is the **only** durable technical input authority. \`RuntimeDelivery\` carries binding, inputId/deliveryId, original messageId and content. Each durable \`RuntimeInput\` stores \`operationRef\` and terminal state. No second queue or ledger.
- \`packages/legacy-agent-host/src/team/commitTeamMessage.ts\` records canonical human/agent sender in the original inbox row and retains \`messageId\` in the selected outbox intent. **Classification must verify the original saved row/receipt, not infer human DM from a last UI bubble, team name, or raw text.**
- \`ClaudeMemberProvider.ts\` and \`CodexMemberProvider.ts\` construct immutable provider config and already own native custody. Supply the new *optional* \`promptSuggestions\` binding only under a captured global opt-in. Keep existing Session SPI types and non-enabled behavior compatible.
- \`TeamHost.ts\` has bounded \`server.notifyData\` and a capabilities handshake. \`CapturedHostClient.ts\` has bounded notification buffering, with \`takeNotifications()\`. Reuse these; **do not** add a second websocket/SSE server, periodic provider poller, or persistent suggestion store.
- Existing user composer \`MessageComposer.tsx\` selects the correct teammate, team, revision, group and cross-team context. \`MessageComposerInput.tsx\` and \`MentionableTextarea.tsx\` handle current text, chips, mention menus, slash commands, queue and shortcuts. The new UI is a narrow passive **suggestion row** adjacent to the existing editor, not a new rich editor or ghost-caret overlay.

## Five mandatory acceptance invariants

1. **Every teammate:** selection is by actual **captured effective provider on the member's runtime lane**, not lead model/name; includes Claude/Codex lead and all Claude/Codex peers in mixed teams. Unknown/unqualified path is unsupported, never another provider fallback.
2. **Correct human direct input:** only a canonical, authorized, human-authored single-teammate personal message can produce a visible candidate. A background, agent-to-agent, tool, group, cross-team, scheduled, task or bootstrap input can never be shown as a follow-up to the user. Check the original canonical inbox/outbox and the final durable \`inputId + operationRef + messageId\` at publication.
3. **Fenced freshness:** original \`backendId/teamId/runId/memberId/generation/nativeSessionRef/operationRef\` and **conversation selection key** are unchanged on delivery and acceptance; subsequent *executed* native turn/clear/stop/restart/revision invalidates. A never-executed canceled queue record does not erroneously supersede a completed native turn.
4. **No mutation:** candidate is untrusted plain text; one offer only; no auto-send, auto-queue, tool call, history append, draft overwrite, keyboard stealing, product event, extra source turn, or fake authority from transport reconnect. Empty, unsupported, lost connection and stale states render no row and do not fail the chat.
5. **No hidden billing claim:** global default-off opt-in in existing Settings, applies to **all** matching teammates; Claude opt-in is per SDK Query and may incur extra inference even after internal turns. Codex sampling only for verified >=0.165 native root; 0.162 is explicitly unsupported until a separately tested pin upgrade. No automatic unsafe runtime restart.

## UX

One subtle full-width row above the input inside the existing composer surface. Muted text, a small spark icon, at most two preview lines (one in compact), inline **Insert** and dismiss, a tiny **Tab** hint on desktop, no bright cards, no spinner, no oscillating animation. \`Tab\` accepts only with an empty, focused editor and no active IME/mention/slash/task/attachment/queue/revision owner. \`Shift+Tab\` keeps normal focus. \`Escape\` dismisses only this candidate; mouse/touch Insert fills an ordinary editable draft. Existing send action remains separate.

Keep accessible names, real buttons with theme focus rings, localization through the existing team translations and no focus stealing. Verify dark/light/compact/floating, narrow touch targets, reduced-motion, IME and chips. No different UI for lead versus peers.

## Minimal feature structure

\`\`\`text
src/features/native-prompt-suggestions/
  contracts/index.ts               # safe transient DTO; no native provider SDK types
  core/domain/policy.ts             # pure provenance and composer eligibility predicate
  renderer/ui/SuggestionRow.tsx     # passive two-action preview
  renderer/hooks/useSuggestion.ts   # one client subscription and dismissal/freshness
  renderer/index.ts                 # public feature entry
\`\`\`

Add only layers that own real behavior. Host proof belongs in its existing Team/Runtime composition, IPC+HTTP reuse existing \`agent-backend\` adapters. Avoid unneeded main/preload duplications in this UI-only feature.

## One-run no-subscription E2E

- **Provider fixture:** exact artifact from provider CI 43607379609 (provider tgz SHA256 \`c251d13ff4b48ec113d7ede964b7075312b42176f8ae46eebcd04a60d86b9e6a\`; contracts tgz \`aaf9506473f6a2868a375a6087e1b4edc561b38f34101ef7a8703a73bb2674db\`). Pin in frontend vendor only after byte verification. No floating source refs and no silent replacement of another PR's vendor artifact.
- **Host fixture:** real captured Host/Team/Runtime, two members with independent provider instances, original human DM sends, canonical inbox/outbox source proof, exact operation completions. Scripted Claude SDK frames and Codex native JSON-RPC child; no vendor auth.
- **Negative Host cases:** internal task/group/agent peer, other team/same member name, stale generation/turn/session, cancelled queued run, unknown custody, Host restart and restored input, provider failure, 0.162 unsupported.
- **Desktop fixture:** actual selected Electron app with existing composer. Human sends via current visible button, native fixture returns candidate, correct member sees small row. Verify Tab/Insert, Escape, draft preservation, attachment/mention/IME/revision/queue priority, switch recipient and team, light/dark, compact/narrow, and no auto-send.
- **Native binary conditional:** actual selected Claude SDK (0.3.305) and Codex >=0.165 App Server with isolated TEST HOME, localhost scripted inference and no real subscriptions, original model-request context/effects/cleanup. If not executable, **HOLD** and do not call fixture tests a native vendor pass.

### Verification and evidence rules

Use existing Stage 1 candidate/native/Desktop harnesses, not a parallel test framework. Run affected TS 7.0.2 build, lint and feature tests, packed vendor consumer, Host protocol E2E and Electron visual checks. Exact HEAD, provider artifact SHA, Node/OS, in/out request counts, real message identities, cleanup observations, passed/failed/skipped/HOLD and screenshots go into the PR. Queued/skipped work never counts as PASS.

No release, branch cutover to \`main\`, auto-merge of PR #982/#1186 or provider publication without distinct reviewed source and actual requested E2E acceptance. The dedicated stacked PR remains Draft until evidence is complete.

## Review ledger / current HOLDs (2026-11-14)

**Critical review round 1, provenance + dependency (fixes pushed):**
`44d36db`/`87f0339`/`457899e` require and test the **independent captured descriptor run** in both Main owner selection and Host notice projection; team-only rebinding was not sufficient. `60c1940` corrects the one-shot staging workflow's exact previous provider archive selector, without dropping its byte/hash and compare-before-write guards. A queued vendor-staging job is not an adopted or verified artifact.

**Critical review round 2, transport privacy (fix + fail-closed HOLD):**
`src/main/http/events.ts` broadcasts SSE to *every* connected `/api/events` browser. Publishing human-DM suggestion text there is unsafe regardless of renderer filters. `fa5c5a2` stops that Main broadcast; `b08175c` records why. **Electron's selected scoped IPC may receive offers; HTTP browser subscriptions intentionally receive none.** Implement and test per-owner/context authenticated SSE before restoring HTTP delivery. Do not call current HTTP acceptance complete.

**Still required before claiming end-to-end:** real global Settings opt-in and safe Host session application; independent post-publication UI generation/native-turn freshness or revocation (do not compare a candidate to its own fields as proof); staged exact provider archive plus frozen lockfile; actual captured Host native-source/no-subscription proofs; actual Electron UI visual, IME, compact, light/dark and cross-member privacy proofs; Codex consumer binary >=0.165 explicitly adopted and conformance-tested. The isolated provider's native localhost CI `43610197873` (Claude) and `43610197814` (Codex 0.166) **succeeded** on `f08a2e1`; these do **not** qualify Host/Desktop. Current integration CI pending or skipped/cancelled is not PASS.

This is a Draft feature branch only. No main/default/release mutation and no dependent PR merge.
