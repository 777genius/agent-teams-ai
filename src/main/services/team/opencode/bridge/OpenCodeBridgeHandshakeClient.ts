import { types } from 'node:util';

import {
  OPEN_CODE_APP_MANAGED_BOOTSTRAP_CONTRACT_VERSION,
  OPEN_CODE_DELIVERY_ACCEPTANCE_CONTRACT_VERSION,
  OPEN_CODE_EXPECTED_BEHAVIOR_FINGERPRINT_SCHEMA_VERSION,
  OPEN_CODE_FILE_PARTS_CONTRACT_VERSION,
  OPEN_CODE_TASK_LEDGER_EVIDENCE_CONTRACT_VERSION,
} from './OpenCodeBridgeCommandContract';
import { rememberOpenCodeHandshakeFailure } from './OpenCodeStateChangingBridgeCommandService';

import type {
  OpenCodeBridgeCommandName,
  OpenCodeBridgeFailure,
  OpenCodeBridgeHandshake,
  OpenCodeBridgePeerIdentity,
} from './OpenCodeBridgeCommandContract';
import type {
  OpenCodeBridgeCommandExecutor,
  OpenCodeBridgeHandshakePort,
} from './OpenCodeStateChangingBridgeCommandService';

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
  let kindValue: unknown, messageValue: unknown;
  try {
    kindValue = field(failure, 'kind');
    messageValue = field(failure, 'message');
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
  rememberOpenCodeHandshakeFailure(error, {
    kind,
    ...(sdkCode ? { sdkCode } : {}),
    ...(nativeOperation ? { nativeOperation } : {}),
    ...(nativeErrno !== undefined ? { nativeErrno } : {}),
  });
  return error;
}

export interface OpenCodeBridgeCommandHandshakePortOptions {
  bridge: OpenCodeBridgeCommandExecutor;
  clientIdentity: OpenCodeBridgePeerIdentity;
  timeoutMs?: number;
}

const DEFAULT_HANDSHAKE_TIMEOUT_MS = 120_000;

export class OpenCodeBridgeCommandHandshakePort implements OpenCodeBridgeHandshakePort {
  private readonly bridge: OpenCodeBridgeCommandExecutor;
  private readonly clientIdentity: OpenCodeBridgePeerIdentity;
  private readonly timeoutMs: number;

  constructor(options: OpenCodeBridgeCommandHandshakePortOptions) {
    this.bridge = options.bridge;
    this.clientIdentity = options.clientIdentity;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS;
  }

  async handshake(input: {
    requiredCommand: OpenCodeBridgeCommandName;
    expectedRunId: string | null;
    expectedCapabilitySnapshotId: string | null;
    expectedManifestHighWatermark: number | null;
    cwd?: string;
    allowEmptyLaneStop?: boolean;
    selectedModel?: string | null;
    toolApprovalMode?: 'auto' | 'manual';
    teamId?: string;
    teamName?: string;
    memberName?: string;
    laneId?: string | null;
  }): Promise<OpenCodeBridgeHandshake> {
    const deadline = Date.now() + this.timeoutMs;
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

      // Handshake precedes command dispatch. Retry only a structured, retryable
      // registry contention result; ownership loss and all other failures propagate.
      if (
        !result.ok &&
        result.error.retryable &&
        result.error.kind === 'provider_error' &&
        result.error.details?.lockCode === 'ELOCKED' &&
        result.error.details?.lockCategory === 'registry' &&
        attempt < 3 &&
        Date.now() + 250 < deadline
      ) {
        await new Promise<void>((resolve) => setTimeout(resolve, 250));
        continue;
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
