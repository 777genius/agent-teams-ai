# Issue #1152 — OpenCode lead-directed plain-text reply delivery

Status: research-only plan; implementation is in [app PR #1157](https://github.com/777genius/agent-teams-ai/pull/1157). This plan PR changes no production behavior.

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
| Cancellation or stopped team during read/write | Check ownership immediately before write; a concurrent stop during the physical write requires a serialized cancellation/write fence for strict prevention. Never claim a post-write checkpoint is atomic. |
| Non-lead teammate report and system notice | Optional no-reply semantics preserved; no ping-pong |
| Human/group chat and group non-response | Unchanged group contracts |
| Custom named lead from roster | Mandatory lead reply, not generic teammate report |
| Real peer named `team_lead` (historical lead alias), with separate `captain` lead | Exact roster peer identity wins over alias; no reply or proof redirected to `captain` |
| Reserved `system` recipient / corrupted lead identity | `system` remains an informational, non-addressable marker; reject invalid lead configuration rather than reinterpreting app notices as lead messages |
| V1 and V2 session transcript source | Bound canonical message extraction, no cross-session fallback |

Tests should cover pure policy cases, actual inbox/ledger file writes and a native E2E flow with a deterministic synthetic transcript. A live API model call is supplementary, not required for determinism. Include tests for restart recovery and relevant legacy records.

## Review rounds (completed)

1. **Loss and duplication audit:** simply enabling the existing user fallback for `lead_reply` is unsafe because it uses a truncated preview and could race a successful `message_send`. Require exact transcript identity and stable idempotency instead.
2. **Scope and anti-loop audit:** changing `teammate_report` read semantics would restart the old acknowledgement loop. Resolve the canonical lead from team configuration only for this delivery; retain optional peer/system policy, with no new runtime protocol.

## Definition of done

A focused draft implementation PR (separate from this plan) has the precise read-commit and materialization changes; all new and existing messaging/group/restart tests pass; native Electron E2E confirms the lead receives the exact complete answer; two review passes have no outstanding correctness issues. Only then merge. Do not claim issue #1152 fixed by this plan alone.

## Review clarifications and implementation follow-through

- **Legacy preview mismatch:** An existing inbox row containing only a clipped preview must not satisfy canonical reply proof. Re-read the physical row after a send or dedupe, compare its full text with the exact assistant transcript and leave the original unread on any mismatch. An eventual repair must use an explicitly verified new delivery identity; blindly editing or reusing a conflicting ID is unsafe.
- **Message-send uncertainty:** Reinspect only tool outcomes in the same canonical runtime prompt turn. Any send lacking a correlated failure result can have succeeded; never synthesize a second delivery. An older tool call must not prevent a text-only response in a new, exact prompt turn.
- **Roster priority:** An exact current roster peer named `team_lead` must override that historical alias. Keep the same decision in prompt instructions, destination candidate search, read-commit and advisory proof; a missing roster fails closed instead of inferring a recipient.
- **Reserved identity:** `system` is a non-addressable notice token and a reserved teammate name. Preserve notice semantics; validate/reject conflicting persisted lead identity rather than silently treating app notices as user-authored lead messages.
- **Cancellation limit:** The existing checkpoint before/after a physical inbox write is not an atomic cancellation/write lock. Distinguish the current guard from a future serialized fence, and never claim strict no-write-after-stop from checkpoints alone.
- **Direct-user delivery:** This PR targets lead-directed fallback and does not expand the existing direct-user preview behavior. Its separate qualification must not be silently folded into this narrow issue.

Implementation PR #1157 includes file-backed inbox/ledger tests, exact transcript identity, wrong-recipient detection, failed-tool recovery and roster alias regressions. Its full CI, native Electron acceptance and final review determine readiness; this document by itself is not completion evidence.
