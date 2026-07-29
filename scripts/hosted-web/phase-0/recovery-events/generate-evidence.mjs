#!/usr/bin/env node

import { runRecoveryEvidenceGenerator } from './render-recovery-evidence.mjs';

const CHECK = process.argv.includes('--check');

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
      'Required hosted v1 team, task, messaging, review, approval, Git, lifecycle, and runtime-ingress mutations named by the master plan and current TeamsAPI/TeamApprovalsElectronApi/CrossTeamAPI/ReviewAPI/runtime-control seams.',
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

await runRecoveryEvidenceGenerator(buildCommandCatalog, CHECK);
