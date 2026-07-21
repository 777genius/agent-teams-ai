import { encodeReplayCursor } from '@features/coordination-events';

import { parseBackupRunId, parseSha256Digest } from '../../../contracts';

import type {
  BackupAcceptedCommandDrain,
  BackupCoordinationBarrier,
  StateCompatibilityManifestRef,
} from '../../../contracts';
import type {
  BackupCoordinationFlushPort,
  CaptureCoordinationBarrierRequest,
  DrainAcceptedBackupCommandsRequest,
} from '../../../core/application';
import type {
  CoordinationDrainStorageEvidence,
  CoordinationDurabilityStorageGateway,
} from '@features/internal-storage/main';

export interface DurableStateCompatibilityManifestSource {
  captureCurrent(input: {
    readonly backupRunId: string;
    readonly fenceGeneration: number;
  }): Promise<StateCompatibilityManifestRef>;
}

export class SqliteBackupCoordinationFlush implements BackupCoordinationFlushPort {
  constructor(
    private readonly options: {
      readonly storage: CoordinationDurabilityStorageGateway;
      readonly deploymentId: string;
      readonly compatibilityManifest: DurableStateCompatibilityManifestSource;
    }
  ) {
    if (!options.storage || !options.deploymentId || !options.compatibilityManifest) {
      throw new TypeError('sqlite-backup-coordination-flush-options-invalid');
    }
  }

  async drainAcceptedCommands(
    request: DrainAcceptedBackupCommandsRequest
  ): Promise<BackupAcceptedCommandDrain> {
    requireFenceRequest(request.backupRunId, request.fence);
    const evidence = await this.options.storage.coordinationBackupDrain({
      deploymentId: this.options.deploymentId,
      backupRunId: request.backupRunId,
      fenceGeneration: request.fence.generation,
    });
    return toAcceptedCommandDrain(evidence);
  }

  async captureBarrier(
    request: CaptureCoordinationBarrierRequest
  ): Promise<BackupCoordinationBarrier> {
    requireFenceRequest(request.backupRunId, request.fence);
    const evidence = decodeDrainEvidence(request.acceptedCommandDrain.durableBarrier);
    if (
      evidence.backupRunId !== request.backupRunId ||
      evidence.fenceGeneration !== request.fence.generation ||
      request.acceptedCommandDrain.admittedRunId !== request.backupRunId ||
      request.acceptedCommandDrain.fenceGeneration !== request.fence.generation ||
      request.acceptedCommandDrain.throughCommandCursor !==
        commandCursor(evidence.throughCommandSequence)
    ) {
      throw new Error('coordination-backup-drain-evidence-mismatch');
    }

    const compatibility = await this.options.compatibilityManifest.captureCurrent({
      backupRunId: request.backupRunId,
      fenceGeneration: request.fence.generation,
    });
    requireCompatibilityManifest(compatibility);
    const captured = await this.options.storage.coordinationBackupCapture({
      deploymentId: this.options.deploymentId,
      evidence,
    });
    if (captured.durableBarrier !== evidence.durableBarrier) {
      throw new Error('coordination-backup-capture-evidence-mismatch');
    }
    const eventCursor = encodeReplayCursor({
      deploymentId: this.options.deploymentId,
      eventEpoch: captured.eventEpoch,
      eventSequence: captured.throughEventSequence,
    });
    return Object.freeze({
      stateCompatibilityManifest: Object.freeze({ ...compatibility }),
      acceptedCommandDrain: Object.freeze({ ...request.acceptedCommandDrain }),
      participantRecoveryPoints: Object.freeze(
        request.participants
          .map((participant) =>
            Object.freeze({
              participantId: participant.descriptor.participantId,
              sourceGeneration: participant.sourceGeneration,
              durableBarrier: participant.durableBarrier,
            })
          )
          .sort((left, right) => left.participantId.localeCompare(right.participantId))
      ),
      eventCursor,
      eventEpoch: captured.eventEpoch,
      journalCursors: Object.freeze({
        applicationCommandOutbox: commandCursor(captured.throughCommandSequence),
        coordinationEvents: eventCursor,
      }),
    });
  }
}

function toAcceptedCommandDrain(
  evidence: CoordinationDrainStorageEvidence
): BackupAcceptedCommandDrain {
  return Object.freeze({
    admittedRunId: parseBackupRunId(evidence.backupRunId),
    fenceGeneration: evidence.fenceGeneration,
    throughCommandCursor: commandCursor(evidence.throughCommandSequence),
    durableBarrier: evidence.durableBarrier,
  });
}

function commandCursor(sequence: number): string {
  if (!Number.isSafeInteger(sequence) || sequence < 0) {
    throw new Error('coordination-backup-command-cursor-invalid');
  }
  return `application-command-outbox-v1:${sequence}`;
}

function decodeDrainEvidence(durableBarrier: string): CoordinationDrainStorageEvidence {
  const prefix = 'coordination-drain-v1.';
  if (typeof durableBarrier !== 'string' || !durableBarrier.startsWith(prefix)) {
    throw new Error('coordination-backup-drain-evidence-invalid');
  }
  let value: unknown;
  try {
    value = JSON.parse(
      Buffer.from(durableBarrier.slice(prefix.length), 'base64url').toString('utf8')
    ) as unknown;
  } catch {
    throw new Error('coordination-backup-drain-evidence-invalid');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('coordination-backup-drain-evidence-invalid');
  }
  const record = value as Record<string, unknown>;
  if (
    typeof record.backupRunId !== 'string' ||
    !Number.isSafeInteger(record.fenceGeneration) ||
    !Number.isSafeInteger(record.throughCommandSequence) ||
    !Number.isSafeInteger(record.throughEventSequence) ||
    typeof record.eventEpoch !== 'string'
  ) {
    throw new Error('coordination-backup-drain-evidence-invalid');
  }
  return Object.freeze({
    backupRunId: record.backupRunId,
    fenceGeneration: record.fenceGeneration as number,
    throughCommandSequence: record.throughCommandSequence as number,
    throughEventSequence: record.throughEventSequence as number,
    eventEpoch: record.eventEpoch,
    durableBarrier,
  });
}

function requireCompatibilityManifest(manifest: StateCompatibilityManifestRef): void {
  if (
    !manifest ||
    typeof manifest.manifestId !== 'string' ||
    manifest.manifestId.length === 0 ||
    manifest.schemaVersion !== 3
  ) {
    throw new Error('coordination-backup-compatibility-manifest-invalid');
  }
  parseSha256Digest(manifest.sha256);
}

function requireFenceRequest(
  backupRunId: string,
  fence: { readonly generation: number; readonly admittedRunId: string }
): void {
  if (
    fence.admittedRunId !== backupRunId ||
    !Number.isSafeInteger(fence.generation) ||
    fence.generation <= 0
  ) {
    throw new Error('coordination-backup-flush-fence-invalid');
  }
}
