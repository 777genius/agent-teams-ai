import { createSafeAppError, type QueryContext, type SafeAppError } from '@shared/contracts/hosted';

import {
  type CanonicalListTeamLifecycleResult,
  type GetRuntimeStateProjectionRequest,
  type GetRuntimeStateProjectionResult,
  type GetTeamLifecycleSnapshotRequest,
  type GetTeamLifecycleSnapshotResult,
  type ListAliveTeamProjectionsRequest,
  type ListAliveTeamProjectionsResult,
  type ListTeamLifecycleRequest,
  parseCanonicalListTeamLifecycleResult,
  parseGetRuntimeStateProjectionRequest,
  parseGetTeamLifecycleSnapshotRequest,
  parseListAliveTeamProjectionsRequest,
  parseListTeamLifecycleRequest,
  TEAM_LIFECYCLE_READ_SCHEMA_VERSION,
  type TeamLifecycleReadFailure,
  type TeamLifecycleReadFailureCode,
} from '../../../contracts/team-lifecycle-read';

import type { TeamLifecycleReadApi } from '../../../contracts/team-lifecycle-read-api';
import type { GetRuntimeStateProjection } from '../../../core/application/GetRuntimeStateProjection';
import type { GetTeamLifecycleSnapshot } from '../../../core/application/GetTeamLifecycleSnapshot';
import type { ListAliveTeamProjections } from '../../../core/application/ListAliveTeamProjections';
import type { ListTeamLifecycle } from '../../../core/application/ListTeamLifecycle';

export interface TeamLifecycleReadUseCases {
  readonly list: Pick<ListTeamLifecycle, 'execute'>;
  readonly snapshot: Pick<GetTeamLifecycleSnapshot, 'execute'>;
  readonly runtime: Pick<GetRuntimeStateProjection, 'execute'>;
  readonly alive: Pick<ListAliveTeamProjections, 'execute'>;
}

function failure(error: SafeAppError): TeamLifecycleReadFailure {
  return Object.freeze({
    schemaVersion: TEAM_LIFECYCLE_READ_SCHEMA_VERSION,
    kind: 'failure',
    error: error as SafeAppError & { readonly code: TeamLifecycleReadFailureCode },
    retryable: error.code === 'unavailable',
  });
}

function unexpectedFailure(): TeamLifecycleReadFailure {
  return failure(
    createSafeAppError({
      code: 'internal',
      reason: 'unexpected',
      diagnosticId: 'team-lifecycle-api.unexpected',
    })
  );
}

export class TeamLifecycleReadApiAdapter implements TeamLifecycleReadApi {
  constructor(private readonly useCases: TeamLifecycleReadUseCases) {}

  async listTeamLifecycle(
    requestValue: ListTeamLifecycleRequest,
    context: QueryContext
  ): Promise<CanonicalListTeamLifecycleResult> {
    const request = parseListTeamLifecycleRequest(requestValue);
    if (!request.ok) return failure(request.error);

    try {
      const result = await this.useCases.list.execute(request.value, context);
      const canonical = parseCanonicalListTeamLifecycleResult(result);
      return canonical.ok ? canonical.value : failure(canonical.error);
    } catch {
      return unexpectedFailure();
    }
  }

  async getTeamLifecycleSnapshot(
    requestValue: GetTeamLifecycleSnapshotRequest,
    context: QueryContext
  ): Promise<GetTeamLifecycleSnapshotResult> {
    const request = parseGetTeamLifecycleSnapshotRequest(requestValue);
    if (!request.ok) return failure(request.error);
    try {
      return await this.useCases.snapshot.execute(request.value, context);
    } catch {
      return unexpectedFailure();
    }
  }

  async getRuntimeStateProjection(
    requestValue: GetRuntimeStateProjectionRequest,
    context: QueryContext
  ): Promise<GetRuntimeStateProjectionResult> {
    const request = parseGetRuntimeStateProjectionRequest(requestValue);
    if (!request.ok) return failure(request.error);
    try {
      return await this.useCases.runtime.execute(request.value, context);
    } catch {
      return unexpectedFailure();
    }
  }

  async listAliveTeamProjections(
    requestValue: ListAliveTeamProjectionsRequest,
    context: QueryContext
  ): Promise<ListAliveTeamProjectionsResult> {
    const request = parseListAliveTeamProjectionsRequest(requestValue);
    if (!request.ok) return failure(request.error);
    try {
      return await this.useCases.alive.execute(request.value, context);
    } catch {
      return unexpectedFailure();
    }
  }
}
