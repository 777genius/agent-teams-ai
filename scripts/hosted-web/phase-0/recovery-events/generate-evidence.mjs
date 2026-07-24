#!/usr/bin/env node
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { format } from 'prettier';

import {
  encodeIntent,
  fingerprintIntent,
  resolveClaim,
  runEffectRecoveryScheduler,
  runSnapshotScheduler,
  validateCommandCatalog,
} from './model.mjs';
import { verifyCrossLaneOwnerAgreement, verifyMutationCensus } from './mutation-census.mjs';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(SCRIPT_DIR, '../../../..');
const OUT = resolve(ROOT, 'docs/research/hosted-web/phase-0/recovery-events');
const MUTATION_MANIFEST_PATH = resolve(OUT, 'mutation-surface-manifest.json');
const W1_API_PARITY_LEDGER_PATH = resolve(
  ROOT,
  'docs/research/hosted-web/phase-0/parity-renderer/api-parity-ledger.json'
);
const FINGERPRINT_ORACLE_PATH = resolve(
  ROOT,
  'test/architecture/hosted-web/phase-0/recovery-events/fixtures/fingerprint-oracle-vectors.json'
);
const CHECK = process.argv.includes('--check');
const FIXTURE_KEY_V1 = 'phase-0-w5-public-fixture-key-v1';
const FIXTURE_KEY_V2 = 'phase-0-w5-public-fixture-key-v2';

const tx = (effectId = 'commit_state_and_event') => ({
  effectId,
  recoveryClass: 'transactional_local',
  candidateRecoveryClass: 'transactional_local',
  proofRequired: 'command outcome and bounded journal row commit in the same internal transaction',
  currentEvidence: 'missing_hosted_internal_storage',
  ambiguousOutcome: 'recover_from_transaction',
  automaticRecoveryAdmitted: false,
  currentRecoveryDisposition: 'operator_required_until_transaction_exists',
  writerAuthority: 'app-exclusive internal-storage worker',
  writerEvidenceRef: 'P0.W3.WRITER_COORDINATION:sqlite.mutate',
});
const op = (effectId, evidence) => ({
  effectId,
  recoveryClass: 'non_reconcilable',
  candidateRecoveryClass: 'idempotent_by_operation_id',
  proofRequired: evidence,
  currentEvidence: 'unproved_durable_lookup_or_writer_coordination',
  ambiguousOutcome: 'operator_required',
  automaticRecoveryAdmitted: false,
  currentRecoveryDisposition: 'operator_required',
  writerAuthority: 'external or compatibility writer; operation lookup unproved',
  writerEvidenceRef: 'P0.W3.WRITER_COORDINATION',
});
const unique = (effectId, evidence) => ({
  effectId,
  recoveryClass: 'reconcilable_by_unique_evidence',
  candidateRecoveryClass: 'reconcilable_by_unique_evidence',
  proofRequired: evidence,
  currentEvidence: 'missing_operation_bound_before_after_evidence',
  ambiguousOutcome: 'prove_absent_or_succeeded_before_retry',
  automaticRecoveryAdmitted: false,
  currentRecoveryDisposition: 'operator_required',
  writerAuthority: 'effect-specific external writer coordination required',
  writerEvidenceRef: 'P0.W3.WRITER_COORDINATION',
});
const nonrec = (effectId, reason) => ({
  effectId,
  recoveryClass: 'non_reconcilable',
  candidateRecoveryClass: 'non_reconcilable',
  proofRequired: reason,
  currentEvidence: 'boundary_can_be_ambiguous',
  ambiguousOutcome: 'operator_required',
  automaticRecoveryAdmitted: false,
  currentRecoveryDisposition: 'operator_required',
  writerAuthority: 'uncoordinated or acknowledgement-free external writer',
  writerEvidenceRef: 'P0.W3.WRITER_COORDINATION',
});

function descriptor(commandKind, featureOwner, sourceMethods, normalizedIntentFields, effects) {
  return {
    commandKind,
    featureOwner,
    sourceMethods,
    inputSchemaVersion: 1,
    fingerprintVersion: 'hmac-sha256-ld-v1',
    idempotencyScope: 'deployment_actor_command_kind_key',
    retentionClass: effects.some((effect) => effect.recoveryClass === 'non_reconcilable')
      ? 'operator_resolution_plus_receipt_ttl'
      : 'command_outcome_plus_receipt_ttl',
    normalizedIntentFields,
    fingerprintRecordFields: [
      'descriptorId',
      'inputSchemaVersion',
      'fingerprintVersion',
      'keyVersion',
      'digest',
    ],
    effects: effects.map((effect, index) => ({
      effectOwner: featureOwner,
      effectRole: index === 0 ? 'coordinator_effect' : 'secondary_effect',
      ...effect,
    })),
  };
}

function buildCommandCatalog(mutationManifest) {
  const commands = [
    descriptor(
      'team.soft_delete',
      'team-lifecycle',
      ['deleteTeam'],
      ['teamId', 'teamGeneration'],
      [
        tx(),
        unique(
          'move_team_to_tombstone',
          'operationId plus exact source/destination identity and generation'
        ),
      ]
    ),
    descriptor(
      'team.restore',
      'team-lifecycle',
      ['restoreTeam'],
      ['teamId', 'tombstoneGeneration'],
      [
        tx(),
        unique('restore_team_files', 'operationId plus tombstone and restored identity evidence'),
      ]
    ),
    descriptor(
      'team.permanent_delete',
      'team-lifecycle',
      ['permanentlyDeleteTeam'],
      ['teamId', 'teamGeneration', 'expectedOwnershipDigest'],
      [
        tx('commit_deletion_saga'),
        unique(
          'revoke_run_and_remove_owned_artifacts',
          'saga step IDs plus ownership catalog and absence proof'
        ),
      ]
    ),
    descriptor(
      'team.draft_delete',
      'team-lifecycle',
      ['deleteDraft'],
      ['teamId', 'draftGeneration'],
      [
        tx(),
        unique(
          'remove_draft_artifacts',
          'operationId plus exact draft generation and absence proof'
        ),
      ]
    ),
    descriptor(
      'git.initialize_repository',
      'workspace-registry',
      ['initializeGitRepository'],
      ['workspaceId', 'repositoryId', 'mountGeneration'],
      [
        tx('commit_git_intent'),
        nonrec(
          'run_git_init',
          'current Git subprocess has no operation-bound acknowledgement after timeout'
        ),
      ]
    ),
    descriptor(
      'git.create_initial_commit',
      'workspace-registry',
      ['createInitialGitCommit'],
      ['workspaceId', 'repositoryId', 'expectedHead', 'treeDigest'],
      [
        tx('commit_git_intent'),
        unique(
          'create_commit',
          'operationId trailer or exact expected parent/tree/ref transition under workspace guard'
        ),
      ]
    ),
    descriptor(
      'team.create_draft',
      'team-lifecycle',
      ['createTeam', 'createConfig'],
      ['teamId', 'workspaceId', 'configDigest', 'rosterDigest'],
      [
        tx(),
        unique(
          'replace_team_config',
          'exclusive write intent plus operationId and before/after checksums'
        ),
      ]
    ),
    descriptor(
      'team.launch',
      'team-lifecycle',
      ['launchTeam'],
      [
        'teamId',
        'teamGeneration',
        'workspaceId',
        'mountGeneration',
        'providerPlanDigest',
        'launchPreferencesDigest',
      ],
      [
        tx('commit_launch_workflow'),
        nonrec(
          'provider_launch',
          'current launch evidence can time out between provider spawn and durable process ownership proof'
        ),
      ]
    ),
    descriptor(
      'team.cancel_provisioning',
      'team-lifecycle',
      ['cancelProvisioning'],
      ['teamId', 'runId', 'runGeneration'],
      [
        tx(),
        unique(
          'cancel_owned_run',
          'run credential revocation plus generation-scoped terminal evidence'
        ),
      ]
    ),
    descriptor(
      'team.stop',
      'team-lifecycle',
      ['stop'],
      ['teamId', 'runId', 'runGeneration'],
      [
        tx('commit_stop_workflow'),
        unique(
          'terminate_owned_processes',
          'process ownership record, generation fence, and verified terminal state'
        ),
      ]
    ),
    descriptor(
      'team.config_update',
      'team-lifecycle',
      ['updateConfig'],
      ['teamId', 'expectedRevision', 'configPatchDigest'],
      [
        tx(),
        unique(
          'replace_team_config',
          'operationId plus exact expected revision and before/after checksums'
        ),
      ]
    ),
    descriptor(
      'message.send',
      'team-messaging',
      ['sendMessage', 'processSend'],
      ['teamId', 'messageId', 'recipientId', 'contentDigest', 'attachmentDigests'],
      [
        tx('commit_message_intent'),
        op('append_inbox_envelope', 'messageId is a durable unique envelope marker'),
        nonrec(
          'provider_live_delivery',
          'without provider acknowledgement or unique observable envelope marker a timeout cannot prove acceptance'
        ),
      ]
    ),
    descriptor(
      'cross_team_message.send',
      'team-messaging',
      ['crossTeam.send'],
      ['fromTeamId', 'toTeamId', 'recipientId', 'messageId', 'contentDigest', 'taskRefDigest'],
      [
        tx('commit_cross_team_intent'),
        op(
          'append_cross_team_envelope',
          'messageId and conversationId uniquely identify the durable envelope'
        ),
        nonrec(
          'provider_live_delivery',
          'runtime delivery lacks universal durable acknowledgement'
        ),
      ]
    ),
    descriptor(
      'task.create',
      'team-task-board',
      ['createTask'],
      ['teamId', 'taskId', 'expectedTeamRevision', 'taskIntentDigest'],
      [tx(), op('write_task_document', 'taskId/operationId survives watcher echo and retry')]
    ),
    descriptor(
      'task.request_review',
      'team-task-board',
      ['requestReview'],
      ['teamId', 'taskId', 'expectedTaskRevision'],
      [
        tx(),
        op('notify_review_requested', 'operationId uniquely identifies notification/history entry'),
      ]
    ),
    descriptor(
      'task.update_kanban',
      'team-task-board',
      ['updateKanban'],
      ['teamId', 'taskId', 'expectedTaskRevision', 'patchDigest'],
      [tx(), op('write_task_and_kanban', 'operationId plus expected task/team revisions')]
    ),
    descriptor(
      'kanban.reorder_column',
      'team-task-board',
      ['updateKanbanColumnOrder'],
      ['teamId', 'columnId', 'expectedTeamRevision', 'orderedTaskIdsDigest'],
      [
        tx(),
        unique('replace_kanban_order', 'exact before revision and operation-bound after digest'),
      ]
    ),
    descriptor(
      'task.update_status',
      'team-task-board',
      ['updateTaskStatus'],
      ['teamId', 'taskId', 'expectedTaskRevision', 'status'],
      [tx(), op('write_task_status', 'operationId and task history transition marker')]
    ),
    descriptor(
      'task.update_owner',
      'team-task-board',
      ['updateTaskOwner'],
      ['teamId', 'taskId', 'expectedTaskRevision', 'ownerMemberId'],
      [tx(), op('write_task_owner', 'operationId and task history transition marker')]
    ),
    descriptor(
      'task.update_fields',
      'team-task-board',
      ['updateTaskFields'],
      ['teamId', 'taskId', 'expectedTaskRevision', 'fieldPatchDigest'],
      [tx(), op('write_task_fields', 'operationId and expected revision preserve unrelated fields')]
    ),
    descriptor(
      'task.start',
      'team-task-board',
      ['startTask', 'startTaskByUser'],
      ['teamId', 'taskId', 'expectedTaskRevision', 'ownerMemberId'],
      [
        tx('commit_started_interval'),
        op(
          'notify_task_owner',
          'notification operationId yields explicit persisted/delivery outcome'
        ),
      ]
    ),
    descriptor(
      'task.add_comment',
      'team-task-board',
      ['addTaskComment'],
      ['teamId', 'taskId', 'commentId', 'contentDigest', 'taskRefDigest'],
      [tx(), op('append_comment', 'commentId/operationId uniquely identifies history entry')]
    ),
    descriptor(
      'task.set_clarification',
      'team-task-board',
      ['setTaskClarification'],
      ['teamId', 'taskId', 'expectedTaskRevision', 'clarificationOwner'],
      [tx(), op('write_clarification', 'operationId and expected revision')]
    ),
    descriptor(
      'task.soft_delete',
      'team-task-board',
      ['softDeleteTask'],
      ['teamId', 'taskId', 'expectedTaskRevision'],
      [tx(), op('write_task_tombstone', 'taskId plus tombstone generation')]
    ),
    descriptor(
      'task.restore',
      'team-task-board',
      ['restoreTask'],
      ['teamId', 'taskId', 'tombstoneGeneration'],
      [tx(), op('restore_task_document', 'taskId plus tombstone generation')]
    ),
    descriptor(
      'task.relationship_add',
      'team-task-board',
      ['addTaskRelationship'],
      ['teamId', 'taskId', 'targetTaskId', 'relationshipType', 'expectedTaskRevision'],
      [tx(), op('append_relationship', 'operationId deduplicates symmetric history updates')]
    ),
    descriptor(
      'task.relationship_remove',
      'team-task-board',
      ['removeTaskRelationship'],
      ['teamId', 'taskId', 'targetTaskId', 'relationshipType', 'expectedTaskRevision'],
      [tx(), op('remove_relationship', 'operationId and expected relationship generation')]
    ),
    descriptor(
      'task.attachment_save',
      'agent-attachments',
      ['saveTaskAttachment'],
      ['teamId', 'taskId', 'attachmentId', 'contentDigest', 'mediaType'],
      [
        tx(),
        unique(
          'store_attachment',
          'attachmentId plus operation-bound content digest and atomic replace evidence'
        ),
      ]
    ),
    descriptor(
      'task.attachment_delete',
      'agent-attachments',
      ['deleteTaskAttachment'],
      ['teamId', 'taskId', 'attachmentId', 'attachmentGeneration'],
      [
        tx(),
        unique('remove_attachment', 'attachment generation plus operation-bound absence evidence'),
      ]
    ),
    descriptor(
      'member.add',
      'team-lifecycle',
      ['addMember'],
      ['teamId', 'expectedRosterGeneration', 'memberId', 'memberSpecDigest'],
      [tx(), op('write_roster', 'memberId plus roster generation')]
    ),
    descriptor(
      'member.replace_roster',
      'team-lifecycle',
      ['replaceMembers'],
      ['teamId', 'expectedRosterGeneration', 'rosterDigest'],
      [tx(), unique('replace_roster', 'operationId plus exact before generation and after digest')]
    ),
    descriptor(
      'member.remove',
      'team-lifecycle',
      ['removeMember'],
      ['teamId', 'memberId', 'expectedRosterGeneration'],
      [tx(), op('write_member_tombstone', 'memberId plus roster generation')]
    ),
    descriptor(
      'member.restore',
      'team-lifecycle',
      ['restoreMember'],
      ['teamId', 'memberId', 'tombstoneGeneration'],
      [tx(), op('restore_roster_member', 'memberId plus tombstone generation')]
    ),
    descriptor(
      'member.update_role',
      'team-lifecycle',
      ['updateMemberRole'],
      ['teamId', 'memberId', 'expectedRosterGeneration', 'roleDigest'],
      [tx(), op('write_member_role', 'operationId plus roster generation')]
    ),
    descriptor(
      'member.restart',
      'team-lifecycle',
      ['restartMember'],
      ['teamId', 'runId', 'runGeneration', 'memberId'],
      [
        tx('commit_restart_workflow'),
        {
          ...nonrec(
            'provider_member_restart',
            'spawn may occur before durable provider acknowledgement'
          ),
          effectOwner: 'team-runtime-control',
        },
      ]
    ),
    descriptor(
      'member.retry_failed_lanes',
      'team-runtime-control',
      ['retryFailedOpenCodeSecondaryLanes'],
      ['teamId', 'runId', 'runGeneration', 'failedLaneSetDigest'],
      [
        tx('commit_retry_workflow'),
        nonrec(
          'provider_lane_launch',
          'current retry candidates can cross spawn boundary before evidence commit'
        ),
      ]
    ),
    descriptor(
      'member.skip_for_launch',
      'team-lifecycle',
      ['skipMemberForLaunch'],
      ['teamId', 'runId', 'runGeneration', 'memberId'],
      [
        tx(),
        {
          ...op('write_launch_skip', 'memberId/run generation transition is uniquely journaled'),
          effectOwner: 'team-runtime-control',
        },
      ]
    ),
    descriptor(
      'process.kill',
      'team-runtime-control',
      ['killProcess'],
      ['teamId', 'runId', 'runGeneration', 'processRef'],
      [
        tx('commit_kill_intent'),
        unique(
          'terminate_owned_process',
          'opaque processRef ownership plus generation and terminal observation'
        ),
      ]
    ),
    descriptor(
      'approval.decide',
      'team-approvals',
      ['respondToToolApproval'],
      ['teamId', 'runId', 'runGeneration', 'approvalRequestId', 'decision', 'decisionDigest'],
      [
        tx('claim_approval_decision'),
        nonrec(
          'provider_permission_delivery',
          'a timeout can occur after provider accepted the answer but before acknowledgement'
        ),
      ]
    ),
    descriptor(
      'approval.policy_update',
      'team-approvals',
      ['updateToolApprovalSettings'],
      ['teamId', 'expectedPolicyVersion', 'policyDigest'],
      [tx()]
    ),
    descriptor(
      'review.apply_decisions',
      'team-review',
      ['applyDecisions'],
      ['teamId', 'workspaceId', 'changeSetId', 'expectedSourceGeneration', 'decisionDigest'],
      [
        tx('commit_review_intent'),
        nonrec(
          'apply_workspace_patch',
          'agent-writable workspace equality cannot identify which writer produced bytes'
        ),
      ]
    ),
    descriptor(
      'review.reject_hunks',
      'team-review',
      ['rejectHunks'],
      ['workspaceId', 'fileRef', 'expectedContentDigest', 'hunkSelectionDigest'],
      [
        tx('commit_review_intent'),
        nonrec(
          'replace_workspace_file',
          'current path-based write has no operation-bound exclusive evidence'
        ),
      ]
    ),
    descriptor(
      'review.reject_file',
      'team-review',
      ['rejectFile'],
      ['workspaceId', 'fileRef', 'expectedContentDigest', 'replacementDigest'],
      [
        tx('commit_review_intent'),
        nonrec(
          'replace_workspace_file',
          'current path-based write has no operation-bound exclusive evidence'
        ),
      ]
    ),
    descriptor(
      'review.save_edited_file',
      'team-review',
      ['saveEditedFile'],
      ['workspaceId', 'fileRef', 'expectedContentDigest', 'replacementDigest'],
      [
        tx('commit_review_intent'),
        nonrec(
          'replace_workspace_file',
          'current path-based write has no operation-bound exclusive evidence'
        ),
      ]
    ),
    descriptor(
      'review.save_decisions',
      'team-review',
      ['saveDecisions'],
      ['teamId', 'scopeKey', 'scopeToken', 'decisionDigest'],
      [
        tx(),
        unique('replace_review_decisions', 'operationId plus exact scope token and after digest'),
      ]
    ),
    descriptor(
      'review.clear_decisions',
      'team-review',
      ['clearDecisions'],
      ['teamId', 'scopeKey', 'scopeToken'],
      [tx(), unique('remove_review_decisions', 'scope token plus operation-bound absence evidence')]
    ),
    descriptor(
      'runtime.bootstrap_checkin',
      'team-runtime-control',
      ['recordOpenCodeRuntimeBootstrapCheckin'],
      ['teamId', 'runId', 'runGeneration', 'laneId', 'runtimeEventId', 'evidenceDigest'],
      [tx(), op('accept_runtime_checkin', 'runtimeEventId and run/lane credential scope')]
    ),
    descriptor(
      'runtime.deliver_message',
      'team-runtime-control',
      ['deliverOpenCodeRuntimeMessage'],
      [
        'teamId',
        'runId',
        'runGeneration',
        'laneId',
        'runtimeEventId',
        'destinationDigest',
        'payloadDigest',
      ],
      [
        tx('claim_runtime_delivery'),
        op('append_runtime_envelope', 'runtime event id and destination message id'),
      ]
    ),
    descriptor(
      'runtime.task_event',
      'team-runtime-control',
      ['recordOpenCodeRuntimeTaskEvent'],
      ['teamId', 'runId', 'runGeneration', 'laneId', 'runtimeEventId', 'taskEventDigest'],
      [tx(), op('accept_runtime_task_event', 'runtimeEventId deduplicates watcher/provider echo')]
    ),
    descriptor(
      'runtime.heartbeat',
      'team-runtime-control',
      ['recordOpenCodeRuntimeHeartbeat'],
      ['teamId', 'runId', 'runGeneration', 'laneId', 'runtimeEventId', 'livenessDigest'],
      [tx(), op('accept_runtime_heartbeat', 'runtimeEventId and monotonic run generation')]
    ),
  ];
  const requiredMutationMethods = mutationManifest.rows
    .filter((entry) => entry.disposition === 'required_hosted_v1_mutation')
    .map((entry) => (entry.id === 'CrossTeamAPI.send' ? 'crossTeam.send' : entry.sourceMethod));
  return {
    schemaVersion: 1,
    evidenceId: 'P0.W5.COMMAND_CATALOG',
    scope:
      'Required hosted v1 team, task, messaging, review, approval, Git, lifecycle, and runtime-ingress mutations named by the master plan and current TeamsAPI/CrossTeamAPI/ReviewAPI/runtime-control seams.',
    descriptorDefaults: {
      claimOrder: 'authenticate_authorize_bound_validate_then_claim',
      conflict: 'same scope/key with changed descriptor/schema/fingerprint is idempotency_mismatch',
      storedCommandMaterial: 'versions_and_hmac_digest_only',
      sensitiveBodyPersistence: false,
    },
    coverage: {
      censusArtifact: 'mutation-census.json',
      censusDerivation:
        'independent TypeScript AST extraction bidirectionally checked against mutation-surface-manifest.json; never derived from commands',
      requiredMutationMethods,
      aliases: { 'crossTeam.send': 'CrossTeamAPI.send' },
      dispositionManifest: 'mutation-surface-manifest.json',
      excludedAsQueryOrEphemeral: mutationManifest.rows
        .filter((entry) => ['query', 'ephemeral'].includes(entry.disposition))
        .map((entry) => entry.id),
      deferredOutsideHostedV1: [
        ...mutationManifest.rows
          .filter((entry) => entry.disposition === 'deferred')
          .map((entry) => entry.id),
        ...mutationManifest.deferredScopes.map((entry) => entry.scope),
      ],
    },
    commands,
  };
}

function buildEventInventory() {
  return {
    schemaVersion: 1,
    evidenceId: 'P0.W5.EVENT_CURSOR_INVENTORY',
    observedAtSha: 'a32f509e6d9bd31ba2135940e336729bf90c3d93',
    surfaces: [
      {
        id: 'generic-http-sse',
        source: 'src/main/http/events.ts:13',
        producer: 'HttpServer.broadcast callers',
        consumer: 'HttpAPIClient EventSource',
        cursor: 'none',
        durability: 'module-global in-memory Set<FastifyReply>',
        replay: 'none',
        scope: 'all connected clients',
        finding:
          'No id/eventId/journal/Last-Event-ID handling; disconnect or commit-before-fanout loses the notification.',
      },
      {
        id: 'browser-eventsource',
        source: 'src/renderer/api/httpClient.ts:176',
        producer: '/api/events',
        consumer: 'renderer channel listeners',
        cursor: 'browser transport only; server emits no id',
        durability: 'none',
        replay: 'automatic reconnect cannot replay without server IDs/journal',
        scope: 'one global route',
        finding:
          'JSON callbacks have no event identity, resource revision, subscription locator, gap detection, or resync path.',
      },
      {
        id: 'team-file-watcher-ipc-and-sse',
        source: 'src/main/index.ts:1504',
        producer: 'FileWatcher/team reconciliation',
        consumer: 'Electron renderer and generic HTTP broadcast',
        cursor: 'none',
        durability: 'filesystem remains authority; watcher event is a hint',
        replay: 'periodic/focused refresh only',
        scope: 'teamName/type payload',
        finding:
          'Forwarding precedes no durable event row and carries no source generation/fileWriterEpoch.',
      },
      {
        id: 'renderer-team-reconciler',
        source: 'src/renderer/store/index.ts:1620',
        producer: 'onTeamChange and provisioning progress callbacks',
        consumer: 'Zustand team state',
        cursor: 'none',
        durability: 'memory cache',
        replay: 'throttled refresh and fallback polling',
        scope: 'teamName plus partial runId guards',
        finding:
          'Some stale-run guards exist, but no eventId dedupe, opaque epoch cursor, revision vector, or snapshot barrier.',
      },
      {
        id: 'opencode-runtime-delivery-journal',
        source: 'src/main/services/team/opencode/delivery/RuntimeDeliveryJournal.ts:7',
        producer: 'runtime delivery service',
        consumer: 'delivery recovery/status',
        cursor: 'none',
        durability: 'versioned JSON store with lock',
        replay: 'resume pending by key/payload hash',
        scope: 'key/runId/teamName',
        finding:
          'Rejects payload conflict and records committed location, but uses unversioned stable hash and retries pending without an ADR-34 per-effect evidence class.',
      },
      {
        id: 'opencode-prompt-delivery-ledger',
        source: 'src/main/services/team/opencode/delivery/OpenCodePromptDeliveryLedger.ts:11',
        producer: 'OpenCode inbox delivery/watchdog',
        consumer: 'delivery status and repair',
        cursor: 'provider pre/post prompt cursors, not application event cursor',
        durability: 'versioned JSON store',
        replay: 'bounded retry/watchdog states',
        scope: 'team/member/lane/run/message',
        finding:
          'Rich acceptanceUnknown/evidence exists, but payloadHash is not a versioned normalized-intent HMAC and provider cursors cannot be used as the hosted event barrier.',
      },
      {
        id: 'opencode-bridge-command-ledger',
        source: 'src/main/services/team/opencode/bridge/OpenCodeBridgeCommandLedgerStore.ts:7',
        producer: 'state-changing bridge command service',
        consumer: 'bridge commandStatus recovery',
        cursor: 'none',
        durability: 'versioned JSON store',
        replay: 'completed duplicate resolves via status; unknown timeout blocks retry',
        scope: 'generated idempotency key',
        finding:
          'Correctly refuses blind retry after unknown timeout, but requestHash includes raw body and lacks descriptor/schema/fingerprint/key versions and stable actor scope.',
      },
      {
        id: 'runtime-control-event-sink',
        source: 'src/main/services/team/runtime-control/RuntimeControlService.ts:154',
        producer: 'provider ack',
        consumer: 'optional runtime event sink',
        cursor: 'provider/runtime event identity only',
        durability: 'sink-dependent and invoked after provider action',
        replay: 'provider-specific',
        scope: 'run/lane/idempotency key',
        finding:
          'Action completes before eventSink.record; crash between them demonstrates why hosted state/outbox must be durable before live fanout.',
      },
    ],
    requiredTargetContract: {
      cursor: 'opaque deploymentId/eventEpoch/eventSequence',
      snapshot: 'same-transaction cursor or retained lower C0 plus revision vector',
      delivery:
        'listener-before-query durable journal replay with heartbeat/high-watermark requery',
      reducer: 'eventId dedupe plus aggregate generation/revision fencing; gaps refetch',
      externalFiles:
        'watch-before-scan, source hash/generation, observation sequence, fileWriterEpoch',
    },
    conclusion:
      'Current generic HTTP/team-change flow is a lossy notification path and cannot satisfy ADR-33. Existing provider journals are useful salvage evidence, not a hosted event cursor.',
  };
}

function buildFingerprintGoldens(oracle) {
  const materializeLaunchDefaults = (input) => ({
    teamId: input.teamId,
    providerPlanDigest: input.providerPlanDigest,
    effort: input.effort ?? 'medium',
    fast: input.fast ?? false,
  });
  const cases = [
    {
      id: 'send-v1-field-order-a',
      descriptorId: 'message.send',
      schemaVersion: 1,
      fingerprintVersion: 'hmac-sha256-ld-v1',
      keyVersion: 'fixture-v1',
      key: FIXTURE_KEY_V1,
      intent: {
        teamId: 'team_01',
        messageId: 'msg_01',
        contentDigest: 'sha256:aaaa',
        attachmentDigests: [],
      },
    },
    {
      id: 'send-v1-field-order-b',
      descriptorId: 'message.send',
      schemaVersion: 1,
      fingerprintVersion: 'hmac-sha256-ld-v1',
      keyVersion: 'fixture-v1',
      key: FIXTURE_KEY_V1,
      intent: {
        attachmentDigests: [],
        contentDigest: 'sha256:aaaa',
        messageId: 'msg_01',
        teamId: 'team_01',
      },
    },
    {
      id: 'send-v1-changed-intent',
      descriptorId: 'message.send',
      schemaVersion: 1,
      fingerprintVersion: 'hmac-sha256-ld-v1',
      keyVersion: 'fixture-v1',
      key: FIXTURE_KEY_V1,
      intent: {
        teamId: 'team_01',
        messageId: 'msg_01',
        contentDigest: 'sha256:bbbb',
        attachmentDigests: [],
      },
    },
    {
      id: 'send-v1-ordered-attachment-array',
      descriptorId: 'message.send',
      schemaVersion: 1,
      fingerprintVersion: 'hmac-sha256-ld-v1',
      keyVersion: 'fixture-v1',
      key: FIXTURE_KEY_V1,
      intent: {
        teamId: 'team_01',
        messageId: 'msg_02',
        contentDigest: 'sha256:eeee',
        attachmentDigests: ['sha256:one', 'sha256:two'],
      },
    },
    {
      id: 'unicode-and-integer-bounds-v1',
      descriptorId: 'task.create',
      schemaVersion: 1,
      fingerprintVersion: 'hmac-sha256-ld-v1',
      keyVersion: 'fixture-v1',
      key: FIXTURE_KEY_V1,
      intent: {
        teamId: 'team_雪',
        taskId: 'task_é',
        expectedTeamRevision: 9007199254740991,
        taskIntentDigest: 'sha256:cccc',
      },
    },
    {
      id: 'launch-default-materialized-v1',
      descriptorId: 'team.launch',
      schemaVersion: 1,
      fingerprintVersion: 'hmac-sha256-ld-v1',
      keyVersion: 'fixture-v1',
      key: FIXTURE_KEY_V1,
      normalizationCase: 'explicit_defaults',
      intent: materializeLaunchDefaults({
        teamId: 'team_01',
        providerPlanDigest: 'sha256:dddd',
        effort: 'medium',
        fast: false,
      }),
    },
    {
      id: 'launch-default-omitted-v1',
      descriptorId: 'team.launch',
      schemaVersion: 1,
      fingerprintVersion: 'hmac-sha256-ld-v1',
      keyVersion: 'fixture-v1',
      key: FIXTURE_KEY_V1,
      normalizationCase: 'omitted_defaults_materialized_before_fingerprint',
      intent: materializeLaunchDefaults({ teamId: 'team_01', providerPlanDigest: 'sha256:dddd' }),
    },
    {
      id: 'launch-schema-v2-retained-key-v1',
      descriptorId: 'team.launch',
      schemaVersion: 2,
      fingerprintVersion: 'hmac-sha256-ld-v1',
      keyVersion: 'fixture-v1',
      key: FIXTURE_KEY_V1,
      intent: {
        teamId: 'team_01',
        providerPlanDigest: 'sha256:dddd',
        effort: 'medium',
        fast: false,
        topologyVersion: 2,
      },
    },
    {
      id: 'launch-key-rotation-v2',
      descriptorId: 'team.launch',
      schemaVersion: 2,
      fingerprintVersion: 'hmac-sha256-ld-v1',
      keyVersion: 'fixture-v2',
      key: FIXTURE_KEY_V2,
      intent: {
        teamId: 'team_01',
        providerPlanDigest: 'sha256:dddd',
        effort: 'medium',
        fast: false,
        topologyVersion: 2,
      },
    },
    {
      id: 'launch-fingerprint-version-v2-retained-key-v1',
      descriptorId: 'team.launch',
      schemaVersion: 2,
      fingerprintVersion: 'hmac-sha256-ld-v2',
      keyVersion: 'fixture-v1',
      key: FIXTURE_KEY_V1,
      intent: {
        teamId: 'team_01',
        providerPlanDigest: 'sha256:dddd',
        effort: 'medium',
        fast: false,
        topologyVersion: 2,
      },
    },
  ].map(({ key, ...entry }) => ({
    ...entry,
    digest: fingerprintIntent({ ...entry, key }),
  }));
  const oracleById = new Map(oracle.vectors.map((vector) => [vector.id, vector]));
  const oracleErrors = [];
  for (const entry of cases) {
    const vector = oracleById.get(entry.id);
    if (!vector) {
      oracleErrors.push(`missing immutable oracle vector ${entry.id}`);
      continue;
    }
    const encoded = encodeIntent({
      descriptorId: entry.descriptorId,
      schemaVersion: entry.schemaVersion,
      fingerprintVersion: entry.fingerprintVersion,
      intent: entry.intent,
    });
    if (encoded !== vector.expectedEncoding) {
      oracleErrors.push(`encoding mismatch against immutable oracle ${entry.id}`);
    }
    if (entry.digest !== vector.expectedDigest) {
      oracleErrors.push(`digest mismatch against immutable oracle ${entry.id}`);
    }
  }
  for (const vector of oracle.vectors) {
    if (!cases.some((entry) => entry.id === vector.id)) {
      oracleErrors.push(`stale immutable oracle vector ${vector.id}`);
    }
  }
  if (oracleErrors.length) {
    throw new Error(`Fingerprint oracle mismatch:\n${oracleErrors.join('\n')}`);
  }
  const byId = Object.fromEntries(cases.map((item) => [item.id, item]));
  const original = byId['send-v1-field-order-a'];
  return {
    schemaVersion: 1,
    evidenceId: 'P0.W5.FINGERPRINT_GOLDENS',
    encoder:
      'recursive UTF-8 byte-length-delimited typed encoding; object keys sorted; safe integers only',
    algorithm: 'HMAC-SHA-256',
    fixtureKeys:
      'public test-only keys are held by the generator and never represent production secrets',
    storedMaterial: 'descriptor/schema/fingerprint/key versions and digest only; no command body',
    immutableOracle:
      'test/architecture/hosted-web/phase-0/recovery-events/fixtures/fingerprint-oracle-vectors.json',
    immutableOracleVectorCount: oracle.vectors.length,
    cases,
    assertions: {
      fieldOrderEqual:
        byId['send-v1-field-order-a'].digest === byId['send-v1-field-order-b'].digest,
      changedIntentDiffers: original.digest !== byId['send-v1-changed-intent'].digest,
      omittedDefaultEqualsMaterialized:
        byId['launch-default-materialized-v1'].digest === byId['launch-default-omitted-v1'].digest,
      schemaVersionDiffers:
        byId['launch-default-materialized-v1'].digest !==
        byId['launch-schema-v2-retained-key-v1'].digest,
      keyVersionDiffers:
        byId['launch-schema-v2-retained-key-v1'].digest !== byId['launch-key-rotation-v2'].digest,
      fingerprintVersionDiffers:
        byId['launch-schema-v2-retained-key-v1'].digest !==
        byId['launch-fingerprint-version-v2-retained-key-v1'].digest,
      retainedFingerprintV1StillComputable:
        fingerprintIntent({ ...byId['launch-schema-v2-retained-key-v1'], key: FIXTURE_KEY_V1 }) ===
        byId['launch-schema-v2-retained-key-v1'].digest,
      retainedSameIntentOutcome: resolveClaim(original, { ...original }).outcome,
      changedIntentReuseOutcome: resolveClaim(original, byId['send-v1-changed-intent']).outcome,
      immutableOracleMatch: true,
    },
  };
}

function buildEstimate() {
  return {
    schemaVersion: 1,
    evidenceId: 'P0.W5.ESTIMATE',
    bucketId: 'EST-RECOVERY-STATE',
    packages: [
      'shared command descriptors/fingerprints',
      'internal-storage command/effect registry',
      'event journal/SSE handoff',
      'renderer reconciliation',
      'provider effect adapters',
    ],
    productionLines: { low: 2700, high: 4400 },
    testLines: { low: 1800, high: 3100 },
    deletedLines: { low: 200, high: 500 },
    excludedGeneratedVendorLines: true,
    overlap: [
      'W3 owns SQLite coordination, external writer classification, backup, and schema mechanics; do not sum its shared transaction/storage fixtures twice.',
    ],
    confidence: 'medium-low',
    assumptions: [
      'One hosted journal writer and one internal SQLite substrate are accepted.',
      'Current OpenCode delivery evidence is adapted rather than rewritten wholesale.',
      'Terminal recovery remains excluded from v1.',
      'Workspace/provider ambiguous effects remain operator_required unless later probes prove unique evidence.',
    ],
    evidenceRefs: [
      'P0.W5.EVENT_CURSOR_INVENTORY',
      'P0.W5.SNAPSHOT_HANDOFF_SCHEDULER',
      'P0.W5.COMMAND_CATALOG',
      'P0.W5.EFFECT_RECOVERY_MATRIX',
      'P0.W5.FINGERPRINT_GOLDENS',
    ],
    totalChangedLines: { low: 4500, high: 7500 },
    reestimateTriggers: [
      'W3 rejects a single SQLite writer/transaction seam',
      'provider launch/delivery cannot expose operation-bound evidence',
      'command catalog expands beyond hosted v1 capability matrix',
      'retention/keyring requires a separate service or migration',
    ],
  };
}

function buildMutationCensus(manifest, verification, crossLaneVerification) {
  return {
    schemaVersion: 1,
    artifactId: 'P0.W5.SUPPORTING.MUTATION_CENSUS',
    observedAtSha: 'a32f509e6d9bd31ba2135940e336729bf90c3d93',
    derivation:
      'TypeScript AST extraction compared bidirectionally with the independently maintained mutation-surface-manifest.json and command descriptors',
    sourceFiles: [...new Set(manifest.rows.map((entry) => entry.sourceFile))],
    rowCount: manifest.rows.length,
    dispositionCounts: verification.counts,
    rows: manifest.rows.map((entry) => ({
      ...entry,
      sourceObserved: true,
    })),
    assertions: {
      everyRowSourceObserved: true,
      sourceToManifestComplete: true,
      manifestToSourceComplete: true,
      everyMutationMappedExactlyOnce: true,
      noCatalogMethodOutsideRequiredDisposition: true,
      ownerAgreement: true,
      crossLaneOwnerAgreement: crossLaneVerification.errors.length === 0,
      omissionNegativeFixturesRejected: true,
    },
  };
}

function exactEffectScheduleMatches(schedule) {
  const compensation = schedule.crashPause.includes('compensation');
  const ambiguous =
    schedule.recoveryClass === 'non_reconcilable' &&
    ['before_external_call', 'after_external_call', 'before_evidence_query'].includes(
      schedule.crashPause
    );
  const outcome = compensation ? 'compensated' : ambiguous ? 'operator_required' : 'committed';
  const externalEffects = ambiguous && schedule.crashPause === 'before_external_call' ? 0 : 1;
  const externalCallAttempts =
    schedule.recoveryClass === 'transactional_local' || externalEffects === 0 ? 0 : 1;
  const evidenceDisposition = ambiguous
    ? 'unproved'
    : schedule.recoveryClass === 'transactional_local'
      ? 'same_transaction'
      : schedule.recoveryClass === 'idempotent_by_operation_id'
        ? 'durable_operation_lookup'
        : schedule.recoveryClass === 'non_reconcilable'
          ? 'explicit_in_call_ack'
          : 'operation_bound_unique_evidence';
  return (
    schedule.outcome === outcome &&
    schedule.durableAfterRecovery.state ===
      (compensation ? 'compensated' : ambiguous ? 'ambiguous' : 'observed_succeeded') &&
    schedule.durableAfterRecovery.commandOutcome === outcome &&
    schedule.durableAfterRecovery.journalCommitted === !ambiguous &&
    schedule.durableAfterRecovery.evidenceDisposition === evidenceDisposition &&
    schedule.externalCallAttempts === externalCallAttempts &&
    schedule.externalEffects === externalEffects &&
    schedule.compensationAttempts === (compensation ? 1 : 0) &&
    schedule.compensationEffects === (compensation ? 1 : 0) &&
    schedule.publicationAttempts ===
      (ambiguous ? 0 : schedule.crashPause === 'after_event_publication' ? 2 : 1)
  );
}

function buildReport({ catalog, scheduler, effectMatrix, goldens }) {
  const ambiguous = effectMatrix.effects.filter(
    (effect) => effect.recoveryClass === 'non_reconcilable'
  );
  return (
    `# Phase 0 W5 recovery and event evidence\n\n` +
    `Pinned phase start: \`a32f509e6d9bd31ba2135940e336729bf90c3d93\`. Packet: \`phase-00-r2\`. This is Phase 0 evidence and executable modeling only; it does not implement the Phase 1 hosted journal, command registry, or renderer.\n\n` +
    `## Findings\n\n` +
    `- The current generic HTTP SSE route and renderer EventSource have no durable cursor, event ID, replay, scope, or gap detection. File-watcher team changes are lossy hints.\n` +
    `- Existing OpenCode delivery/bridge journals provide valuable conflict and ambiguity evidence. They are JSON-store/provider-specific, hash raw or partially normalized payloads without retained ADR-34 descriptor/key versions, and cannot serve as the hosted event journal.\n` +
    `- The deterministic snapshot scheduler explored ${scheduler.exploredScheduleCount} mutation schedules, including actual before/after commit transitions. All converged; lower-C0 schedules deliberately admitted duplicates. Both negative controls reproduced a lost committed event.\n` +
    `- The independent pinned-source census classifies ${catalog.coverage.observedSurfaceCount} extracted interface members and maps ${catalog.coverage.observedMethodCount} required mutations exactly once to ${catalog.commands.length} normalized command kinds and ${effectMatrix.effects.length} owned effects. Bidirectional missing/extra and omitted-descriptor fixtures fail closed.\n` +
    `- The external ownership gate compares ${catalog.coverage.crossLaneOwnership.comparedRequiredW1W5Members} required W1/W5 API members against the W1 API parity ledger and fails generation on a missing row or primary command-owner drift. Coordinator effects remain owned by the primary command feature; published secondary effects retain their distinct effect owner.\n` +
    `- The recovery scheduler executed ${effectMatrix.faultScheduler.exploredScheduleCount} real two-process crash/restart schedules. Every attempt exited at its scheduled boundary, a different PID reloaded only durable command/provider files, and exact post-restart state/effect/compensation/publication counts passed. Stale, coincidentally equal, mismatched-operation and lost-response negative controls all fail closed.\n` +
    `- Current task/inbox/provider lookup and active-writer coordination remain unproved by W3, so those external effects are \`non_reconcilable\`/\`operator_required\`; a future operation-ID class remains only a candidate until independently exercised. Same-key changed intent resolves to \`${goldens.assertions.changedIntentReuseOutcome}\`.\n\n` +
    `## Accepted handoff contract\n\n` +
    `SQLite-only snapshots read the projection, revision vector, and cursor from one transaction. Any external-file projection captures and pins retained C0 before its stable scan and returns C0. SSE registers its wake listener before its first durable query and repeatedly queries the high watermark; wake-ups never carry authority. Reducers deduplicate eventId and fence aggregate generation/revision.\n\n` +
    `This is at-least-once convergence, not event sourcing or exactly-once delivery. The durable journal row is an after-commit projection/outbox record; feature repositories remain state authority.\n\n` +
    `## Ambiguous effects\n\n` +
    ambiguous
      .map(
        (effect) =>
          `- \`${effect.commandKind}/${effect.effectId}\`: ${effect.proofRequired} -> \`operator_required\`.`
      )
      .join('\n') +
    `\n\n## Uncertainty and cross-lane dependency\n\n` +
    `W3 proves that task/config/native-inbox active writers are uncoordinated or quiescent-only today and that selected OpenCode evidence remains partial. This W5 remediation therefore admits no automatic row whose durable lookup/transaction/exclusivity proof is missing. W3 must still confirm the future single-writer SQLite transaction, retention/backup/keyring preservation, and every effect-specific external-writer seam. The 4.5k-7.5k estimate shares storage fixtures with W3 and must be deduplicated by the controller.\n\n` +
    `## Evidence index\n\n` +
    `- \`P0.W5.EVENT_CURSOR_INVENTORY\`: \`event-cursor-inventory.json\`\n` +
    `- \`P0.W5.SNAPSHOT_HANDOFF_SCHEDULER\`: \`snapshot-handoff-scheduler.json\`\n` +
    `- \`P0.W5.COMMAND_CATALOG\`: \`command-catalog.json\`\n` +
    `- \`P0.W5.EFFECT_RECOVERY_MATRIX\`: \`effect-recovery-matrix.json\`\n` +
    `- \`P0.W5.FINGERPRINT_GOLDENS\`: \`fingerprint-goldens.json\`\n` +
    `- \`P0.W5.ESTIMATE\`: \`estimate-input.json\`\n`
  );
}

async function renderOutputs() {
  const mutationManifest = JSON.parse(await readFile(MUTATION_MANIFEST_PATH, 'utf8'));
  const w1ApiParityLedger = JSON.parse(await readFile(W1_API_PARITY_LEDGER_PATH, 'utf8'));
  const fingerprintOracle = JSON.parse(await readFile(FINGERPRINT_ORACLE_PATH, 'utf8'));
  const catalog = buildCommandCatalog(mutationManifest);
  const censusVerification = await verifyMutationCensus({
    root: ROOT,
    manifest: mutationManifest,
    catalog,
  });
  if (censusVerification.errors.length) {
    throw new Error(`Mutation census invalid:\n${censusVerification.errors.join('\n')}`);
  }
  const crossLaneOwnerVerification = verifyCrossLaneOwnerAgreement({
    w1Ledger: w1ApiParityLedger,
    manifest: mutationManifest,
    catalog,
  });
  if (crossLaneOwnerVerification.errors.length) {
    throw new Error(
      `W1-to-W5 command owner drift:\n${crossLaneOwnerVerification.errors.join('\n')}`
    );
  }
  catalog.coverage.observedSurfaceCount = censusVerification.counts.extracted;
  catalog.coverage.observedMethodCount = censusVerification.counts.required;
  catalog.coverage.dispositionCounts = censusVerification.counts;
  catalog.coverage.sourceFiles = [
    ...new Set(mutationManifest.rows.map((entry) => entry.sourceFile)),
  ];
  catalog.coverage.sourceToManifestComplete = true;
  catalog.coverage.manifestToSourceComplete = true;
  catalog.coverage.exactlyOnceMapped = true;
  catalog.coverage.noCatalogMethodOutsideRequiredDisposition = true;
  catalog.coverage.ownerAgreement = true;
  catalog.coverage.crossLaneOwnership = {
    authorityArtifact: 'docs/research/hosted-web/phase-0/parity-renderer/api-parity-ledger.json',
    authorityEvidenceId: w1ApiParityLedger.evidenceId,
    ...crossLaneOwnerVerification.counts,
    ownerAgreement: true,
  };
  const errors = validateCommandCatalog(catalog);
  if (errors.length) throw new Error(`Command catalog invalid:\n${errors.join('\n')}`);
  const scheduler = runSnapshotScheduler();
  if (
    scheduler.schedules.some(
      (schedule) => !schedule.converged || schedule.gap || schedule.restartCount !== 1
    )
  ) {
    throw new Error('An accepted snapshot schedule did not converge');
  }
  if (scheduler.schedules.some((schedule) => schedule.mutationCommitTransitions.length !== 2)) {
    throw new Error('A snapshot schedule labeled commit without a real before/after transition');
  }
  if (scheduler.negativeControls.some((control) => !control.reproduced || !control.gap)) {
    throw new Error('A required negative schedule did not reproduce its gap');
  }
  const eventInventory = buildEventInventory();
  const effectRecovery = runEffectRecoveryScheduler();
  if (effectRecovery.schedules.some((schedule) => schedule.duplicateEffect)) {
    throw new Error('An effect recovery schedule repeated an external effect');
  }
  if (
    effectRecovery.schedules.some(
      (schedule) =>
        schedule.restartCount !== 1 ||
        schedule.attemptExitCode !== 86 ||
        schedule.recoveryExitCode !== 0 ||
        !schedule.freshProcess ||
        schedule.committedWithoutEvidence
    )
  ) {
    throw new Error(
      'An effect schedule did not perform one durable restart or committed without evidence'
    );
  }
  if (
    effectRecovery.negativeControls.some(
      (control) => control.outcome !== 'operator_required' || control.retryAttempted
    )
  ) {
    throw new Error('An effect negative control did not fail closed');
  }
  if (effectRecovery.schedules.some((schedule) => !exactEffectScheduleMatches(schedule))) {
    throw new Error('An effect schedule did not match its exact post-restart state/effect counts');
  }
  const effectRecoveryEvidence = {
    ...effectRecovery,
    assertions: {
      realAttemptExitAtEveryBoundary: true,
      freshRecoveryProcessEverySchedule: true,
      exactPostRestartStateAndCounts: true,
    },
    schedules: effectRecovery.schedules.map(({ processIds, ...schedule }) => ({
      ...schedule,
      processCount: processIds.length,
    })),
  };
  const effectMatrix = {
    schemaVersion: 1,
    evidenceId: 'P0.W5.EFFECT_RECOVERY_MATRIX',
    stateMachine:
      'not_started -> attempting -> observed_succeeded | observed_absent | ambiguous; compensating -> compensated | ambiguous',
    retryRule:
      'attempting is persisted before the boundary; retry only after descriptor proof establishes deduplication or absence',
    proofScope:
      'fresh Node process crash/restart fixture with durable command and independent external-adapter files; individual catalog rows admit automatic recovery only when automaticRecoveryAdmitted is true',
    ownershipAssertions: {
      everyEffectHasOwner: catalog.commands.every((command) =>
        command.effects.every((effect) => Boolean(effect.effectOwner))
      ),
      everyCoordinatorOwnedByCommandFeature: catalog.commands.every((command) =>
        command.effects
          .filter((effect) => effect.effectRole === 'coordinator_effect')
          .every((effect) => effect.effectOwner === command.featureOwner)
      ),
      everyEffectHasWriterEvidence: catalog.commands.every((command) =>
        command.effects.every((effect) => effect.writerAuthority && effect.writerEvidenceRef)
      ),
      unprovedEffectsFailClosed: catalog.commands.every((command) =>
        command.effects.every(
          (effect) =>
            effect.automaticRecoveryAdmitted ||
            effect.currentRecoveryDisposition.startsWith('operator_required')
        )
      ),
    },
    faultScheduler: effectRecoveryEvidence,
    effects: catalog.commands.flatMap((command) =>
      command.effects.map((effect) => ({ commandKind: command.commandKind, ...effect }))
    ),
  };
  const goldens = buildFingerprintGoldens(fingerprintOracle);
  const estimate = buildEstimate();
  const mutationCensus = buildMutationCensus(
    mutationManifest,
    censusVerification,
    crossLaneOwnerVerification
  );
  const index = {
    schemaVersion: 1,
    laneId: 'w5',
    packetRevision: 'phase-00-r2',
    phaseStartSha: 'a32f509e6d9bd31ba2135940e336729bf90c3d93',
    supportingArtifacts: [
      { id: 'P0.W5.SUPPORTING.MUTATION_CENSUS', path: 'mutation-census.json' },
      {
        id: 'P0.W5.SUPPORTING.MUTATION_SURFACE_MANIFEST',
        path: 'mutation-surface-manifest.json',
      },
    ],
    evidence: [
      ['P0.W5.EVENT_CURSOR_INVENTORY', 'event-cursor-inventory.json'],
      ['P0.W5.SNAPSHOT_HANDOFF_SCHEDULER', 'snapshot-handoff-scheduler.json'],
      ['P0.W5.COMMAND_CATALOG', 'command-catalog.json'],
      ['P0.W5.EFFECT_RECOVERY_MATRIX', 'effect-recovery-matrix.json'],
      ['P0.W5.FINGERPRINT_GOLDENS', 'fingerprint-goldens.json'],
      ['P0.W5.ESTIMATE', 'estimate-input.json'],
    ].map(([id, path]) => ({ id, path })),
  };
  const json = (value, spacing) => `${JSON.stringify(value, null, spacing)}\n`;
  const prettierJson = (value) =>
    format(JSON.stringify(value), { parser: 'json', printWidth: 100, trailingComma: 'none' });
  return new Map([
    ['index.json', json(index)],
    ['event-cursor-inventory.json', json(eventInventory)],
    ['snapshot-handoff-scheduler.json', json(scheduler)],
    ['command-catalog.json', await prettierJson(catalog)],
    ['effect-recovery-matrix.json', json(effectMatrix, 2)],
    ['fingerprint-goldens.json', json(goldens)],
    ['estimate-input.json', json(estimate)],
    ['mutation-census.json', json(mutationCensus, 2)],
    ['README.md', buildReport({ catalog, scheduler, effectMatrix, goldens })],
  ]);
}

async function main() {
  const outputs = await renderOutputs();
  await mkdir(OUT, { recursive: true });
  const mismatches = [];
  for (const [relative, content] of outputs) {
    const target = resolve(OUT, relative);
    if (CHECK) {
      const existing = await readFile(target, 'utf8').catch(() => null);
      if (existing !== content) mismatches.push(relative);
    } else {
      await writeFile(target, content, 'utf8');
    }
  }
  if (mismatches.length)
    throw new Error(`Generated W5 evidence is stale: ${mismatches.join(', ')}`);
  process.stdout.write(`${CHECK ? 'verified' : 'generated'} ${outputs.size} W5 evidence files\n`);
}

await main();
