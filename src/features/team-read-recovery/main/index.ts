import type { TeamReadFailureMetadata } from '../contracts';
import type { IpcResult } from '@shared/types/ipc';

export class TeamReadFailureError extends Error {
  constructor(
    message: string,
    public readonly failure: TeamReadFailureMetadata
  ) {
    super(message);
    this.name = 'TeamReadFailureError';
  }
}

/** Typed worker rejection takes priority over the legacy fatal-error classifier. */
export function classifyTeamReadWorkerFailure(
  error: unknown,
  legacyFatal: boolean
): TeamReadFailureError | null {
  const failure = error instanceof TeamReadFailureError ? error.failure : undefined;
  if ((!failure || failure.kind === 'operation') && !legacyFatal) return null;
  const message = error instanceof Error ? error.message : String(error);
  return new TeamReadFailureError(
    `TEAM_DATA_WORKER_FAILED: ${message}`,
    failure ?? { kind: 'fatal' }
  );
}

export function teamReadFailureResult<T>(error: unknown): IpcResult<T> {
  return {
    success: false,
    error: error instanceof Error ? error.message : String(error),
    ...(error instanceof TeamReadFailureError ? { failure: error.failure } : {}),
  };
}

export type {
  PhysicalOutcome,
  RawReadTask,
  ReadContinuation,
} from '../core/application/PhysicalReadScope';
export { PhysicalReadScope } from '../core/application/PhysicalReadScope';
export type {
  CapturedPathOperation,
  PathCallbacks,
  PathOperationResult,
} from './infrastructure/OwnedPathOperations';
export { OwnedPathOperations } from './infrastructure/OwnedPathOperations';
export type {
  DescriptorAcquisition,
  DescriptorCallbacks,
  DescriptorLimits,
} from './infrastructure/OwnedReadDescriptors';
export { OwnedReadDescriptors } from './infrastructure/OwnedReadDescriptors';
export type { OwnedUtf8ReadOptions } from './infrastructure/readOwnedUtf8';
export { readOwnedUtf8 } from './infrastructure/readOwnedUtf8';
export type { OwnedSyncOptions, OwnedSyncReport } from './infrastructure/syncOwnedPath';
export { syncOwnedPath } from './infrastructure/syncOwnedPath';
export { type OwnedWriteOptions, writeOwnedBytes } from './infrastructure/writeOwnedBytes';
