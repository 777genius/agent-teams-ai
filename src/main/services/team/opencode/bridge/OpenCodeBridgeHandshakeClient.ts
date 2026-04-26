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
  }): Promise<OpenCodeBridgeHandshake> {
    const result = await this.bridge.execute<
      {
        client: OpenCodeBridgePeerIdentity;
        requiredCommand: OpenCodeBridgeCommandName;
        expectedRunId: string | null;
        expectedCapabilitySnapshotId: string | null;
        expectedManifestHighWatermark: number | null;
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
