import {
  OPEN_CODE_APP_MANAGED_BOOTSTRAP_CONTRACT_VERSION,
  OPEN_CODE_DELIVERY_ACCEPTANCE_CONTRACT_VERSION,
  OPEN_CODE_EXPECTED_BEHAVIOR_FINGERPRINT_SCHEMA_VERSION,
  OPEN_CODE_FILE_PARTS_CONTRACT_VERSION,
  OPEN_CODE_TASK_LEDGER_EVIDENCE_CONTRACT_VERSION,
} from './OpenCodeBridgeCommandContract';

import type {
  OpenCodeBridgeCommandName,
  OpenCodeBridgeHandshake,
  OpenCodeBridgePeerIdentity,
} from './OpenCodeBridgeCommandContract';
import type {
  OpenCodeBridgeCommandExecutor,
  OpenCodeBridgeHandshakePort,
} from './OpenCodeStateChangingBridgeCommandService';

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
    laneId?: string | null;
  }): Promise<OpenCodeBridgeHandshake> {
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
        ...(input.laneId === undefined ? {} : { laneId: input.laneId }),
      },
      {
        cwd: input.cwd ?? process.cwd(),
        timeoutMs: this.timeoutMs,
      }
    );

    if (!result.ok) {
      throw new Error(
        `OpenCode bridge handshake failed: ${result.error.kind}: ${result.error.message}`
      );
    }

    return result.data;
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
        'opencode.commandStatus',
        'opencode.readiness',
        'opencode.cleanupHosts',
        'opencode.launchTeam',
        'opencode.reconcileTeam',
        'opencode.stopTeam',
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
