# Phase 0 W5 recovery and event evidence

Pinned phase start: `a32f509e6d9bd31ba2135940e336729bf90c3d93`. Packet: `phase-00-r2`. This is Phase 0 evidence and executable modeling only; it does not implement the Phase 1 hosted journal, command registry, or renderer.

## Findings

- The current generic HTTP SSE route and renderer EventSource have no durable cursor, event ID, replay, scope, or gap detection. File-watcher team changes are lossy hints.
- Existing OpenCode delivery/bridge journals provide valuable conflict and ambiguity evidence. They are JSON-store/provider-specific, hash raw or partially normalized payloads without retained ADR-34 descriptor/key versions, and cannot serve as the hosted event journal.
- The deterministic snapshot scheduler explored 288 mutation schedules, including actual before/after commit transitions. All converged; lower-C0 schedules deliberately admitted duplicates. Both negative controls reproduced a lost committed event.
- The independent pinned-source census classifies 123 extracted interface members and maps 53 required mutations exactly once to 50 normalized command kinds and 101 owned effects. Bidirectional missing/extra and omitted-descriptor fixtures fail closed.
- The external ownership gate compares 49 required W1/W5 API members against the W1 API parity ledger and fails generation on a missing row or primary command-owner drift. Coordinator effects remain owned by the primary command feature; published secondary effects retain their distinct effect owner.
- The recovery scheduler executed 52 real two-process crash/restart schedules. Every attempt exited at its scheduled boundary, a different PID reloaded only durable command/provider files, and exact post-restart state/effect/compensation/publication counts passed. Stale, coincidentally equal, mismatched-operation and lost-response negative controls all fail closed.
- Current task/inbox/provider lookup and active-writer coordination remain unproved by W3, so those external effects are `non_reconcilable`/`operator_required`; a future operation-ID class remains only a candidate until independently exercised. Same-key changed intent resolves to `idempotency_mismatch`.

## Accepted handoff contract

SQLite-only snapshots read the projection, revision vector, and cursor from one transaction. Any external-file projection captures and pins retained C0 before its stable scan and returns C0. SSE registers its wake listener before its first durable query and repeatedly queries the high watermark; wake-ups never carry authority. Reducers deduplicate eventId and fence aggregate generation/revision.

This is at-least-once convergence, not event sourcing or exactly-once delivery. The durable journal row is an after-commit projection/outbox record; feature repositories remain state authority.

## Ambiguous effects

- `git.initialize_repository/run_git_init`: current Git subprocess has no operation-bound acknowledgement after timeout -> `operator_required`.
- `team.launch/provider_launch`: current launch evidence can time out between provider spawn and durable process ownership proof -> `operator_required`.
- `message.send/append_inbox_envelope`: messageId is a durable unique envelope marker -> `operator_required`.
- `message.send/provider_live_delivery`: without provider acknowledgement or unique observable envelope marker a timeout cannot prove acceptance -> `operator_required`.
- `cross_team_message.send/append_cross_team_envelope`: messageId and conversationId uniquely identify the durable envelope -> `operator_required`.
- `cross_team_message.send/provider_live_delivery`: runtime delivery lacks universal durable acknowledgement -> `operator_required`.
- `task.create/write_task_document`: taskId/operationId survives watcher echo and retry -> `operator_required`.
- `task.request_review/notify_review_requested`: operationId uniquely identifies notification/history entry -> `operator_required`.
- `task.update_kanban/write_task_and_kanban`: operationId plus expected task/team revisions -> `operator_required`.
- `task.update_status/write_task_status`: operationId and task history transition marker -> `operator_required`.
- `task.update_owner/write_task_owner`: operationId and task history transition marker -> `operator_required`.
- `task.update_fields/write_task_fields`: operationId and expected revision preserve unrelated fields -> `operator_required`.
- `task.start/notify_task_owner`: notification operationId yields explicit persisted/delivery outcome -> `operator_required`.
- `task.add_comment/append_comment`: commentId/operationId uniquely identifies history entry -> `operator_required`.
- `task.set_clarification/write_clarification`: operationId and expected revision -> `operator_required`.
- `task.soft_delete/write_task_tombstone`: taskId plus tombstone generation -> `operator_required`.
- `task.restore/restore_task_document`: taskId plus tombstone generation -> `operator_required`.
- `task.relationship_add/append_relationship`: operationId deduplicates symmetric history updates -> `operator_required`.
- `task.relationship_remove/remove_relationship`: operationId and expected relationship generation -> `operator_required`.
- `member.add/write_roster`: memberId plus roster generation -> `operator_required`.
- `member.remove/write_member_tombstone`: memberId plus roster generation -> `operator_required`.
- `member.restore/restore_roster_member`: memberId plus tombstone generation -> `operator_required`.
- `member.update_role/write_member_role`: operationId plus roster generation -> `operator_required`.
- `member.restart/provider_member_restart`: spawn may occur before durable provider acknowledgement -> `operator_required`.
- `member.retry_failed_lanes/provider_lane_launch`: current retry candidates can cross spawn boundary before evidence commit -> `operator_required`.
- `member.skip_for_launch/write_launch_skip`: memberId/run generation transition is uniquely journaled -> `operator_required`.
- `approval.decide/provider_permission_delivery`: a timeout can occur after provider accepted the answer but before acknowledgement -> `operator_required`.
- `review.apply_decisions/apply_workspace_patch`: agent-writable workspace equality cannot identify which writer produced bytes -> `operator_required`.
- `review.reject_hunks/replace_workspace_file`: current path-based write has no operation-bound exclusive evidence -> `operator_required`.
- `review.reject_file/replace_workspace_file`: current path-based write has no operation-bound exclusive evidence -> `operator_required`.
- `review.save_edited_file/replace_workspace_file`: current path-based write has no operation-bound exclusive evidence -> `operator_required`.
- `runtime.bootstrap_checkin/accept_runtime_checkin`: runtimeEventId and run/lane credential scope -> `operator_required`.
- `runtime.deliver_message/append_runtime_envelope`: runtime event id and destination message id -> `operator_required`.
- `runtime.task_event/accept_runtime_task_event`: runtimeEventId deduplicates watcher/provider echo -> `operator_required`.
- `runtime.heartbeat/accept_runtime_heartbeat`: runtimeEventId and monotonic run generation -> `operator_required`.

## Uncertainty and cross-lane dependency

W3 proves that task/config/native-inbox active writers are uncoordinated or quiescent-only today and that selected OpenCode evidence remains partial. This W5 remediation therefore admits no automatic row whose durable lookup/transaction/exclusivity proof is missing. W3 must still confirm the future single-writer SQLite transaction, retention/backup/keyring preservation, and every effect-specific external-writer seam. The 4.5k-7.5k estimate shares storage fixtures with W3 and must be deduplicated by the controller.

## Evidence index

- `P0.W5.EVENT_CURSOR_INVENTORY`: `event-cursor-inventory.json`
- `P0.W5.SNAPSHOT_HANDOFF_SCHEDULER`: `snapshot-handoff-scheduler.json`
- `P0.W5.COMMAND_CATALOG`: `command-catalog.json`
- `P0.W5.EFFECT_RECOVERY_MATRIX`: `effect-recovery-matrix.json`
- `P0.W5.FINGERPRINT_GOLDENS`: `fingerprint-goldens.json`
- `P0.W5.ESTIMATE`: `estimate-input.json`
