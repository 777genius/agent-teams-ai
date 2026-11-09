# Issue #1152 — OpenCode lead-directed plain-text reply delivery

Status: research and implementation contract only. No production behavior changes in this plan PR.

## Reproduced from current source

1. `OpenCodeVisibleReplyProofService.materializePlainTextReplyIfNeededCurrent` only writes non-group plain-text replies when `isOpenCodeDirectUserPromptDelivery(record)` is true; a lead relay is dropped even after a successful assistant turn.
2. `isOpenCodePlainTextResponseReadCommitAllowed` allows **non-user** `responded_plain_text` to commit based on a semantically sufficient preview. The inbox is then marked read without a visible recipient reply. The ledger becomes terminal, so watchdog retries cannot recover it.
3. `observedAssistantPreview` is not the complete answer. Re-publishing it would cause silent truncation.
4. `classifyOpenCodeDeliveryReplyContract` determines `lead_reply` by aliases rather than the resolved roster identity. A custom lead name can be misclassified as a reply-optional `teammate_report`.
5. Group non-response, system notices and ordinary teammate reports intentionally allow silent completion to avoid acknowledgement loops. A global “plain text always requires a visible reply” rule is unsafe.

## Scope: a narrow answer-delivery path

- **Lead and user are reply-required.** Treat the lead's actual canonical configured identity as a mandatory recipient for this specific team/delivery. Do not weaken the existing optional-report and informational-notice contracts.
- **Exact canonical assistant text.** Reuse the existing read-only `runtime transcript --projection-only` route, already consumed by `ClaudeMultimodelBridgeService.getOpenCodeTranscript`. Select an assistant log message whose `uuid === observedAssistantMessageId`, with exact `runtimeSessionId`, member, team, lane and run binding. `OpenCodeLogProjector` maps projected assistant UUID to the canonical message ID. Concatenate only text blocks, never thinking/tool results. Do not accept `latestAssistantText` or preview as fallback when the ID does not match.
- **Idempotent materialization.** Reuse `TeamInboxWriter.sendMessage`, `findByRelayOfMessageId` and the existing deterministic reply message ID / runtime-delivery deduplication. Route a direct-user delivery only to the `user` inbox, and a lead-directed delivery only to the *actual configured lead* inbox. Before persisting `visibleReplyInbox` and `visibleReplyMessageId` with `applyDestinationProof`, recheck the destination proof's `to`/inbox identity, `from` teammate, originating `relayOfMessageId` and task refs; never accept another recipient's message or the user fallback as proof for a lead reply.
- **Commit only after destination proof.** The read-commit policy for a reply-required plain-text answer must require durable, semantically sufficient visible proof. On read failure, mismatched assistant ID, missing session/run binding, cancelled run or failed inbox write, keep the delivery pending/retryable and surface its failure; never mark read merely because a preview exists.
- **Respect existing guards.** Preserve cancel/run checkpoint fences, accepted `message_send` correlation, `Already handled`/narrow-ack silence, group non-response, and error/repair attempt budget. Never echo a successful tool send as a second plain-text answer.
- **Strict boundaries.** Implement the missing *lead-directed* path first; preserve the existing direct-user behavior while qualifying the shared text reader separately, so this fix does not silently change user delivery semantics. Resolve custom lead identity at the team/delivery boundary without globally treating every peer message as lead-directed or requiring a broad stored-ledger migration. No new database, global transcript cache, background poller, runtime protocol, feature flag, per-model switch, broad `TeamProvisioningService` refactor or unrelated group-chat behavior change.

## E2E acceptance matrix

| Case | Expected result |
| --- | --- |
| OpenCode text-only teammate replies to lead without tool call | Full answer appears once in lead inbox; original marked read after proof |
| Tool-capable OpenCode replies with `message_send` | Existing tool reply wins; no duplicate plain-text message |
| 10k+ character answer | No preview truncation |
| Transcript contains older/later assistant messages | Only exact assistant ID is accepted |
| Missing transcript, wrong session/run/recipient, not-yet-settled turn | No visible reply invented and no premature read commit |
| Replayed watchdog after write/ledger crash | Exactly one reply; proof repaired idempotently |
| Cancellation or stopped team during read/write | No new delivery after cancellation fence |
| Non-lead teammate report and system notice | Optional no-reply semantics preserved; no ping-pong |
| Human/group chat and group non-response | Unchanged group contracts |
| Custom named lead from roster | Mandatory lead reply, not generic teammate report |
| V1 and V2 session transcript source | Bound canonical message extraction, no cross-session fallback |

Tests should cover pure policy cases, actual inbox/ledger file writes and a native E2E flow with a deterministic synthetic transcript. A live API model call is supplementary, not required for determinism. Include tests for restart recovery and relevant legacy records.

## Review rounds (completed)

1. **Loss and duplication audit:** simply enabling the existing user fallback for `lead_reply` is unsafe because it uses a truncated preview and could race a successful `message_send`. Require exact transcript identity and stable idempotency instead.
2. **Scope and anti-loop audit:** changing `teammate_report` read semantics would restart the old acknowledgement loop. Resolve the canonical lead from team configuration only for this delivery; retain optional peer/system policy, with no new runtime protocol.

## Definition of done

A focused draft implementation PR (separate from this plan) has the precise read-commit and materialization changes; all new and existing messaging/group/restart tests pass; native Electron E2E confirms the lead receives the exact complete answer; two review passes have no outstanding correctness issues. Only then merge. Do not claim issue #1152 fixed by this plan alone.
