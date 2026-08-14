import { ExternalWriterObserverError, scopesEqual } from './externalWriterObserverSupport';

import type {
  ExternalContentChecksum,
  ExternalSelfWriteIntent,
  ExternalWriterScope,
  FileWriterEpoch,
  PendingFileObservation,
} from '../../contracts';
import type { TeamId } from '@shared/contracts/hosted/identifiers';

export interface ExternalWriterSelfWriteEffect {
  readonly fileKey: string;
  readonly expectedChecksum: ExternalContentChecksum;
}

export class ExternalWriterSelfWriteOperations {
  private readonly active = new Map<string, ExternalWriterScope>();

  begin(operationId: string, scope: ExternalWriterScope): void {
    if (operationId.length < 1 || operationId.length > 256 || this.active.has(operationId)) {
      throw new ExternalWriterObserverError('not_running');
    }
    this.active.set(operationId, Object.freeze({ ...scope }));
  }

  prepareCompletion(input: {
    readonly operationId: string;
    readonly effects: readonly ExternalWriterSelfWriteEffect[];
    readonly maximumEffects: number;
    readonly fileWriterEpoch: (scope: ExternalWriterScope) => FileWriterEpoch;
    readonly nextSourceGeneration: (scope: ExternalWriterScope, fileKey: string) => number;
    readonly expiresAtMs: number;
  }): readonly ExternalSelfWriteIntent[] {
    const scope = this.active.get(input.operationId);
    if (!scope || input.effects.length < 1 || input.effects.length > input.maximumEffects) {
      throw new ExternalWriterObserverError('catalog_invalid');
    }
    const fileWriterEpoch = input.fileWriterEpoch(scope);
    return Object.freeze(
      input.effects.map((effect, index) => {
        if (
          effect.fileKey.length < 1 ||
          effect.fileKey.length > 256 ||
          effect.expectedChecksum.length < 1 ||
          effect.expectedChecksum.length > 256
        ) {
          throw new ExternalWriterObserverError('catalog_invalid');
        }
        return Object.freeze({
          intentId: `${input.operationId}:${index}`,
          scope,
          fileKey: effect.fileKey,
          expectedChecksum: effect.expectedChecksum,
          sourceGeneration: input.nextSourceGeneration(scope, effect.fileKey),
          fileWriterEpoch,
          expiresAtMs: input.expiresAtMs,
        });
      })
    );
  }

  release(operationId: string): boolean {
    return this.active.delete(operationId);
  }

  blocks(scope: ExternalWriterScope): boolean {
    return [...this.active.values()].some((active) => scopesEqual(active, scope));
  }
}

export function nextPendingOutsideSelfWriteOperation(input: {
  readonly pending: readonly PendingFileObservation[];
  readonly maximumAttempts: number;
  readonly operations: ExternalWriterSelfWriteOperations;
  readonly teamId?: TeamId;
}): PendingFileObservation | null {
  return (
    input.pending.find(
      (pending) =>
        pending.attempts < input.maximumAttempts &&
        (input.teamId === undefined || pending.scope.teamId === input.teamId) &&
        !input.operations.blocks(pending.scope)
    ) ?? null
  );
}
