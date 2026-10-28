import { createHash } from 'node:crypto';
import { types } from 'node:util';

import {
  OPEN_CODE_APP_MANAGED_BOOTSTRAP_CONTRACT_VERSION,
  OPEN_CODE_DELIVERY_ACCEPTANCE_CONTRACT_VERSION,
  OPEN_CODE_EXPECTED_BEHAVIOR_FINGERPRINT_SCHEMA_VERSION,
  OPEN_CODE_FILE_PARTS_CONTRACT_VERSION,
  OPEN_CODE_TASK_LEDGER_EVIDENCE_CONTRACT_VERSION,
} from './OpenCodeBridgeCommandContract';
import { rememberOpenCodeHandshakeFailure } from './OpenCodeStateChangingCausalFailure';

import type {
  OpenCodeBridgeCommandName,
  OpenCodeBridgeFailure,
  OpenCodeBridgeHandshake,
  OpenCodeBridgePeerIdentity,
} from './OpenCodeBridgeCommandContract';
import type { OpenCodeReadinessHandshake } from './OpenCodeReadinessHandshake';
import type {
  OpenCodeBridgeCommandExecutor,
  OpenCodeBridgeHandshakePort,
} from './OpenCodeStateChangingBridgeCommandService';

/** Ordered prefixes: specific rejections before their catch-all family. */
export const OPEN_CODE_HANDSHAKE_MESSAGE_FAMILIES = [
  ['stop_authority_mismatch', 'OpenCode confirmed stop authority mismatch'],
  ['empty_lane_mismatch', 'OpenCode empty-lane stop authority mismatch'],
  ['lane_authority_unavailable', 'OpenCode lifecycle selected lane authority is unavailable'],
  [
    'capability_snapshot_required',
    'OpenCode lifecycle existing lane requires a capability snapshot',
  ],
  ['run_authority_conflict', 'OpenCode lifecycle stored run authority mismatch'],
  ['run_authority_unavailable', 'OpenCode lifecycle selected run authority is unavailable'],
  ['lifecycle_identifiers_required', 'OpenCode lifecycle authority requires teamId and laneId'],
  ['run_identity_required', 'OpenCode lifecycle authority requires runId'],
  ['lane_scope_unavailable', 'OpenCode lifecycle selected lane scope is unavailable'],
  ['lane_scope_ambiguous', 'OpenCode lifecycle lane scope is ambiguous'],
  ['lane_project_mismatch', 'OpenCode lifecycle lane project authority mismatch'],
  ['host_authority_ambiguous', 'OpenCode lifecycle lane host authority is ambiguous'],
  ['process_authority_ambiguous', 'OpenCode lifecycle lane process authority is ambiguous'],
  ['delivery_lane_stopped', 'OpenCode delivery lane is stopped'],
  [
    'delivery_authority_required',
    'OpenCode selected delivery requires persisted lane capability authority',
  ],
  ['delivery_session_changed', 'OpenCode selected delivery session authority changed'],
  ['observation_launch_unavailable', 'OpenCode observation launch authority is unavailable'],
  ['precondition_mismatch', 'OpenCode bridge expected laneId precondition'],
  ['precondition_mismatch', 'OpenCode bridge expectedRunId precondition'],
  ['strict_launch_evidence', 'OpenCode strict launch profile scope evidence is invalid'],
  ['strict_launch_model', 'OpenCode strict launch requires a provider-qualified selected model'],
  ['runtime_process_changed', 'OpenCode selected session runtime process changed'],
  ['lock_operation', 'OpenCode lock operation failed ['],
  ['lifecycle_rejection', 'OpenCode lifecycle '],
] as const;

/** Preserve only closed facts from a validated failure envelope on the same thrown Error. */
export function createOpenCodeBridgeHandshakeFailure(
  failure: OpenCodeBridgeFailure['error']
): Error {
  const field = (value: unknown, key: string): unknown => {
    if (!value || typeof value !== 'object' || types.isProxy(value) || Array.isArray(value))
      return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && Object.hasOwn(descriptor, 'value') ? descriptor.value : undefined;
  };
  let kindValue: unknown, messageValue: unknown, lockCodeValue: unknown, lockCategoryValue: unknown;
  try {
    kindValue = field(failure, 'kind');
    messageValue = field(failure, 'message');
    const details = field(failure, 'details');
    lockCodeValue = field(details, 'lockCode');
    lockCategoryValue = field(details, 'lockCategory');
  } catch {
    /* No foreign getters. */
  }
  const error = new Error(
    `OpenCode bridge handshake failed: ${typeof kindValue === 'string' ? kindValue : 'unknown'}: ${typeof messageValue === 'string' ? messageValue : 'unknown'}`
  );
  const kind = [
    'unsupported_schema',
    'unsupported_command',
    'invalid_input',
    'runtime_not_ready',
    'provider_error',
    'timeout',
    'transport_watchdog_timeout',
    'contract_violation',
    'internal_error',
  ].find((value) => value === kindValue);
  if (!kind) return error;
  const sdkCodes = [
    'cleanup_unknown',
    'execution_cancelled',
    'execution_containment_dll_identity',
    'execution_containment_filesystem_denied',
    'execution_containment_helper_closed',
    'execution_containment_helper_failed',
    'execution_containment_helper_identity',
    'execution_containment_launcher_denied',
    'execution_containment_pipe_denied',
    'execution_containment_platform_pending',
    'execution_containment_profile_denied',
    'execution_containment_unavailable',
    'execution_containment_unqualified',
    'execution_identity_unknown',
    'execution_invalid_response',
    'execution_native_command_unknown',
    'execution_native_stdio_owner_unknown',
    'execution_native_timeout',
    'execution_native_unknown',
    'execution_owner_alias',
    'execution_owner_archive_identity_mismatch',
    'execution_owner_archive_path_mismatch',
    'execution_owner_archive_reopen_identity_mismatch',
    'execution_owner_archive_unknown',
    'execution_owner_local_volume_required',
    'execution_owner_metadata_budget',
    'execution_owner_metadata_changed',
    'execution_owner_metadata_invalid',
    'execution_owner_metadata_missing',
    'execution_owner_metadata_purpose_invalid',
    'execution_owner_not_private',
    'execution_owner_ntfs_required',
    'execution_owner_path_invalid',
    'execution_owner_prepared_invalid',
    'execution_owner_prepared_purpose_invalid',
    'execution_owner_read_only',
    'execution_owner_unknown',
    'execution_owner_write_through_pending',
    'execution_path_alias',
    'execution_probe',
    'execution_profile_changed',
    'execution_selected_auth_changed',
    'member_authority_ambiguous',
    'operation_timeout',
    'original_session_changed',
    'run_control_accept_timeout',
    'run_control_accept_unknown',
    'run_control_changed',
    'run_control_cleanup_unknown',
    'run_control_config_budget',
    'run_control_config_identity',
    'run_control_connect_unknown',
    'run_control_connection_limit',
    'run_control_disconnected',
    'run_control_endpoint_changed',
    'run_control_foreign',
    'run_control_frame_invalid',
    'run_control_frame_oversize',
    'run_control_frame_too_large',
    'run_control_frame_utf8',
    'run_control_held_identity',
    'run_control_held_inputs',
    'run_control_hmac_unknown',
    'run_control_image_changed',
    'run_control_image_hash',
    'run_control_invalid',
    'run_control_listen_unknown',
    'run_control_native_pending',
    'run_control_native_unknown',
    'run_control_owner_identity',
    'run_control_package_peer_identity',
    'run_control_parent_birth',
    'run_control_parent_join',
    'run_control_path_alias',
    'run_control_peer_identity',
    'run_control_pipe_name',
    'run_control_pipe_security',
    'run_control_process_identity',
    'run_control_pump_failed',
    'run_control_pump_unknown',
    'run_control_read_unknown',
    'run_control_selection_budget',
    'run_control_selection_changed',
    'run_control_selection_missing',
    'run_control_timeout',
    'run_control_write_partial',
    'run_control_write_unknown',
    'run_controller_config_unknown',
    'run_controller_inbox_unknown',
    'run_deadline_expired',
    'run_identity_conflict',
    'run_identity_missing',
    'run_original_behavior_changed',
    'run_original_member_missing',
    'run_original_qualification_missing',
    'run_owner_stale',
    'run_owner_unknown',
    'run_process_appcontainer',
    'run_process_changed',
    'run_process_unknown',
    'run_selected_model_changed',
    'run_state_absent',
    'run_state_acl_unknown',
    'run_state_challenge_changed',
    'run_state_challenge_unknown',
    'run_state_directory',
    'run_state_endpoint_changed',
    'run_state_endpoint_missing',
    'run_state_held_inputs',
    'run_state_identity_changed',
    'run_state_missing',
    'run_state_record_absent',
    'run_state_record_changed',
    'run_state_record_collision',
    'run_state_record_encoding',
    'run_state_record_name',
    'run_state_record_read',
    'run_state_record_rename',
    'run_state_record_size',
    'run_state_record_temporary',
    'run_state_record_unknown',
    'run_state_record_write',
    'run_state_start_changed',
    'run_state_unknown',
    'run_status_unknown',
    'run_stopped_or_unknown',
  ];
  const nativeOperations = [
    'assertLive',
    'identity',
    'launch',
    'ownerArchive',
    'ownerAssertDirectory',
    'ownerCloseDirectory',
    'ownerCreatePreparedDatabase',
    'ownerInspectProfileConfig',
    'ownerOpenDirectory',
    'ownerPreparePrivateDirectory',
    'ownerReadMetadata',
    'ownerReadRecord',
    'ownerSelectConfig',
    'ownerValidateSelectedProfile',
    'ownerWriteExclusive',
    'ownerWriteMetadata',
    'ownerWritePreparedAuth',
    'ownerWritePreparedConfig',
    'retire',
    'runStateAcquire',
    'runStateClose',
    'runStateDiscover',
    'runStateListen',
    'runStateOwnerRetired',
    'runStatePoisonConnection',
    'runStateProcessIdentity',
    'runStateReadControllerInbox',
    'runStateReadRecord',
    'runStateReadStop',
    'runStateRequest',
    'runStateReserve',
    'runStateRespond',
    'runStateSelect',
    'runStateValidateEndpoint',
    'runStateWriteRecord',
    'selfImageCustody',
    'send',
  ];
  const match =
    typeof messageValue === 'string' && messageValue.length <= 512
      ? /^([a-z_]+)(?::([a-z_]+):([0-9]{1,10}))?(?: @native:([A-Za-z][A-Za-z0-9_]*))?$/.exec(
          messageValue
        )
      : null;
  const sdkCode =
    match && (match[3] === undefined || Number(match[3]) <= 0xffffffff)
      ? sdkCodes.find((value) => value === match[1])
      : undefined;
  const nativeOperation =
    sdkCode && match ? nativeOperations.find((value) => value === match[4]) : undefined;
  const nativeErrno = sdkCode && match && match[3] !== undefined ? Number(match[3]) : undefined;
  const lockCode = (['ELOCKED', 'ECOMPROMISED'] as const).find((value) => value === lockCodeValue);
  const lockCategory = (['registry', 'profile', 'startup', 'unknown'] as const).find(
    (value) => value === lockCategoryValue
  );
  const messageShape = match
    ? 'code'
    : typeof messageValue === 'string' &&
        messageValue.startsWith('OpenCode lock operation failed [')
      ? 'lock_operation'
      : 'unclassified';
  // Closed identity of an unclassifiable message: a family label plus a digest
  // that can be matched offline against candidate fixed strings.
  const messageText = typeof messageValue === 'string' ? messageValue.trim() : '';
  const messageFamily = messageText
    ? (OPEN_CODE_HANDSHAKE_MESSAGE_FAMILIES.find(([, prefix]) =>
        messageText.startsWith(prefix)
      )?.[0] ?? 'unclassified')
    : undefined;
  const messageDigest = messageText
    ? createHash('sha256').update(messageText).digest('hex').slice(0, 12)
    : undefined;
  rememberOpenCodeHandshakeFailure(error, {
    kind,
    ...(sdkCode ? { sdkCode } : {}),
    ...(nativeOperation ? { nativeOperation } : {}),
    ...(nativeErrno !== undefined ? { nativeErrno } : {}),
    ...(lockCode ? { lockCode } : {}),
    ...(lockCategory ? { lockCategory } : {}),
    ...(messageFamily ? { messageFamily } : {}),
    ...(messageDigest ? { messageDigest } : {}),
    messageShape,
  });
  return error;
}

export interface OpenCodeBridgeCommandHandshakePortOptions {
  bridge: OpenCodeBridgeCommandExecutor;
  clientIdentity: OpenCodeBridgePeerIdentity;
  timeoutMs?: number;
  readinessHandshake?: OpenCodeReadinessHandshake;
}

const DEFAULT_HANDSHAKE_TIMEOUT_MS = 120_000;

/** Escalating contention backoff; the handshake deadline stays the only bound. */
const OPEN_CODE_HANDSHAKE_RETRY_BACKOFF_MS = [250, 500, 1000, 2000, 4000] as const;
// A retry is only useful when the next attempt itself keeps real budget instead
// of collapsing into a nominal 1 ms dispatch; bounded-retry counts stay intact.
const MIN_HANDSHAKE_ATTEMPT_BUDGET_MS = 100;

/** One-line deterministic lane/authority rejections from the SDK probe path:
 *  retrying them cannot recover, so they propagate immediately. */
const OPEN_CODE_AUTHORITY_REJECTION_PREFIXES = [
  'OpenCode lifecycle ',
  'OpenCode confirmed stop authority mismatch',
  'OpenCode empty-lane stop authority mismatch',
  'OpenCode delivery lane is stopped',
  'OpenCode observation launch authority',
  'OpenCode selected delivery ',
  'OpenCode bridge expected laneId precondition',
  'OpenCode bridge expectedRunId precondition',
] as const;

function isDeterministicOpenCodeAuthorityRejection(message: string): boolean {
  return OPEN_CODE_AUTHORITY_REJECTION_PREFIXES.some((prefix) => message.startsWith(prefix));
}

export class OpenCodeBridgeCommandHandshakePort implements OpenCodeBridgeHandshakePort {
  private readonly bridge: OpenCodeBridgeCommandExecutor;
  private readonly clientIdentity: OpenCodeBridgePeerIdentity;
  private readonly timeoutMs: number;
  private readonly readinessHandshake?: OpenCodeReadinessHandshake;

  constructor(options: OpenCodeBridgeCommandHandshakePortOptions) {
    this.readinessHandshake = options.readinessHandshake;
    this.bridge = options.bridge;
    this.clientIdentity = options.clientIdentity;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS;
  }

  async handshake(input: {
    requiredCommand: OpenCodeBridgeCommandName;
    expectedRunId: string | null;
    expectedCapabilitySnapshotId: string | null;
    expectedManifestHighWatermark: number | null;
    timeoutMs?: number;
    cwd?: string;
    allowEmptyLaneStop?: boolean;
    selectedModel?: string | null;
    effort?: string;
    expectedBehaviorFingerprint?: string | null;
    executionProofIdentity?: string;
    toolApprovalMode?: 'auto' | 'manual';
    teamId?: string;
    teamName?: string;
    memberName?: string;
    laneId?: string | null;
  }): Promise<OpenCodeBridgeHandshake> {
    const inline = this.readinessHandshake?.take(input);
    if (inline) return inline;
    // A per-call command budget only tightens the port ceiling: a stop attempt
    // must settle inside its caller's escalation race.
    const timeoutMs =
      input.timeoutMs === undefined ? this.timeoutMs : Math.min(this.timeoutMs, input.timeoutMs);
    const deadline = Date.now() + timeoutMs;
    for (let attempt = 0; ; attempt++) {
      const result = await this.bridge.execute<
        {
          client: OpenCodeBridgePeerIdentity;
          requiredCommand: OpenCodeBridgeCommandName;
          expectedRunId: string | null;
          expectedCapabilitySnapshotId: string | null;
          expectedManifestHighWatermark: number | null;
          allowEmptyLaneStop?: boolean;
          selectedModel?: string | null;
          effort?: string;
          toolApprovalMode?: 'auto' | 'manual';
          teamId?: string;
          teamName?: string;
          memberName?: string;
          laneId?: string | null;
        },
        OpenCodeBridgeHandshake
      >(
        'opencode.handshake',
        {
          client: this.clientIdentity,
          requiredCommand: input.requiredCommand,
          expectedRunId: input.expectedRunId,
          expectedCapabilitySnapshotId: input.expectedCapabilitySnapshotId,
          expectedManifestHighWatermark: input.expectedManifestHighWatermark,
          ...(input.allowEmptyLaneStop === true ? { allowEmptyLaneStop: true } : {}),
          ...(input.effort === undefined ? {} : { effort: input.effort }),
          ...(input.selectedModel === undefined ? {} : { selectedModel: input.selectedModel }),
          ...(input.toolApprovalMode === undefined
            ? {}
            : { toolApprovalMode: input.toolApprovalMode }),
          ...(input.teamId === undefined ? {} : { teamId: input.teamId }),
          ...(input.teamName === undefined ? {} : { teamName: input.teamName }),
          ...(input.memberName === undefined ? {} : { memberName: input.memberName }),
          ...(input.laneId === undefined ? {} : { laneId: input.laneId }),
        },
        {
          cwd: input.cwd ?? process.cwd(),
          timeoutMs: Math.max(1, deadline - Date.now()),
        }
      );

      // Handshake precedes command dispatch. Retry retryable contention (a held
      // lock of any category, or a transient with no lock facts) with escalating
      // backoff bounded by the original deadline; deterministic lane authority
      // rejections, corrupted locks, and non-retryable failures propagate.
      if (
        !result.ok &&
        result.error.retryable &&
        result.error.kind === 'provider_error' &&
        result.error.details?.lockCode !== 'ECOMPROMISED' &&
        !isDeterministicOpenCodeAuthorityRejection(result.error.message)
      ) {
        const delay =
          OPEN_CODE_HANDSHAKE_RETRY_BACKOFF_MS[
            Math.min(attempt, OPEN_CODE_HANDSHAKE_RETRY_BACKOFF_MS.length - 1)
          ];
        if (Date.now() + delay + MIN_HANDSHAKE_ATTEMPT_BUDGET_MS < deadline) {
          await new Promise<void>((resolve) => setTimeout(resolve, delay));
          continue;
        }
      }
      if (!result.ok) {
        throw createOpenCodeBridgeHandshakeFailure(result.error);
      }

      return result.data;
    }
  }
}

export function createOpenCodeBridgeClientIdentity(input: {
  appVersion: string;
  gitSha?: string | null;
  buildId?: string | null;
}): OpenCodeBridgePeerIdentity {
  return {
    schemaVersion: 1,
    peer: 'claude_team',
    appVersion: input.appVersion,
    gitSha: input.gitSha ?? null,
    buildId: input.buildId ?? null,
    bridgeProtocol: {
      minVersion: 1,
      currentVersion: 1,
      supportedCommands: [
        'opencode.handshake',
        'opencode.sendMessage',
        'opencode.observeMessageDelivery',
        'opencode.commandStatus',
        'opencode.readiness',
        'opencode.cleanupHosts',
        'opencode.cleanupStartupHosts',
        'opencode.launchTeam',
        'opencode.reconcileTeam',
        'opencode.stopTeam',
        'opencode.stopOutcome',
        'opencode.reconcileStop',
        'opencode.answerPermission',
        'opencode.listRuntimePermissions',
        'opencode.getRuntimeTranscript',
        'opencode.recoverDeliveryJournal',
        'opencode.backfillTaskLedger',
      ],
      opencodeTaskLedgerEvidenceContractVersion: OPEN_CODE_TASK_LEDGER_EVIDENCE_CONTRACT_VERSION,
      opencodeAppManagedBootstrapContractVersion: OPEN_CODE_APP_MANAGED_BOOTSTRAP_CONTRACT_VERSION,
      opencodeDeliveryAcceptanceContractVersion: OPEN_CODE_DELIVERY_ACCEPTANCE_CONTRACT_VERSION,
      opencodeFilePartsContractVersion: OPEN_CODE_FILE_PARTS_CONTRACT_VERSION,
      expectedBehaviorFingerprintSchemaVersion:
        OPEN_CODE_EXPECTED_BEHAVIOR_FINGERPRINT_SCHEMA_VERSION,
      groupChatProtocolVersion: 1,
    },
    runtime: {
      providerId: 'opencode',
      binaryPath: null,
      binaryFingerprint: null,
      version: null,
      capabilitySnapshotId: null,
      runtimeStoreManifestHighWatermark: null,
      activeRunId: null,
    },
    featureFlags: {
      opencodeTeamLaunch: true,
      opencodeStateChangingCommands: true,
    },
  };
}
