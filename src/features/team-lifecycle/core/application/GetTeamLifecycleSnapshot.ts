import { createSafeAppError, type QueryContext, type SafeAppError } from '@shared/contracts/hosted';

import {
  type GetTeamLifecycleSnapshotRequest,
  type GetTeamLifecycleSnapshotResult,
  parseGetTeamLifecycleSnapshotRequest,
  parseGetTeamLifecycleSnapshotResult,
  TEAM_LIFECYCLE_READ_SCHEMA_VERSION,
  type TeamLifecycleReadFailure,
  type TeamLifecycleReadFailureCode,
} from '../../contracts/team-lifecycle-read';

export interface TeamLifecycleSnapshotReadPort {
  getTeamLifecycleSnapshot(
    request: GetTeamLifecycleSnapshotRequest,
    context: QueryContext
  ): GetTeamLifecycleSnapshotResult | Promise<GetTeamLifecycleSnapshotResult>;
}

function failure(error: SafeAppError): TeamLifecycleReadFailure {
  return Object.freeze({
    schemaVersion: TEAM_LIFECYCLE_READ_SCHEMA_VERSION,
    kind: 'failure',
    error: error as SafeAppError & { readonly code: TeamLifecycleReadFailureCode },
    retryable: error.code === 'unavailable',
  });
}

function internalFailure(
  reason: 'source_response_invalid' | 'unexpected'
): TeamLifecycleReadFailure {
  return failure(
    createSafeAppError({
      code: 'internal',
      reason,
      diagnosticId: `team-lifecycle-snapshot.${reason}`,
    })
  );
}

export class GetTeamLifecycleSnapshot {
  constructor(private readonly source: TeamLifecycleSnapshotReadPort) {}

  async execute(
    requestValue: unknown,
    context: QueryContext
  ): Promise<GetTeamLifecycleSnapshotResult> {
    const request = parseGetTeamLifecycleSnapshotRequest(requestValue);
    if (!request.ok) return failure(request.error);

    try {
      const sourceResult = await this.source.getTeamLifecycleSnapshot(request.value, context);
      const parsed = parseGetTeamLifecycleSnapshotResult(sourceResult);
      if (!parsed.ok) return internalFailure('source_response_invalid');
      if (
        parsed.value.kind === 'success' &&
        (parsed.value.snapshot.workspaceId !== request.value.workspaceId ||
          parsed.value.snapshot.teamId !== request.value.teamId)
      ) {
        return internalFailure('source_response_invalid');
      }
      return parsed.value;
    } catch {
      return internalFailure('unexpected');
    }
  }
}
