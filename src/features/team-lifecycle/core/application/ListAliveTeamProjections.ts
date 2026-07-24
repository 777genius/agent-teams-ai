import { createSafeAppError, type QueryContext, type SafeAppError } from '@shared/contracts/hosted';

import {
  type ListAliveTeamProjectionsRequest,
  type ListAliveTeamProjectionsResult,
  parseListAliveTeamProjectionsRequest,
  parseListAliveTeamProjectionsResult,
  TEAM_LIFECYCLE_READ_SCHEMA_VERSION,
  type TeamLifecycleReadFailure,
  type TeamLifecycleReadFailureCode,
} from '../../contracts/team-lifecycle-read';

export interface AliveTeamProjectionsReadPort {
  listAliveTeamProjections(
    request: ListAliveTeamProjectionsRequest,
    context: QueryContext
  ): ListAliveTeamProjectionsResult | Promise<ListAliveTeamProjectionsResult>;
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
      diagnosticId: `team-lifecycle-alive.${reason}`,
    })
  );
}

export class ListAliveTeamProjections {
  constructor(private readonly source: AliveTeamProjectionsReadPort) {}

  async execute(
    requestValue: unknown,
    context: QueryContext
  ): Promise<ListAliveTeamProjectionsResult> {
    const request = parseListAliveTeamProjectionsRequest(requestValue);
    if (!request.ok) return failure(request.error);

    try {
      const sourceResult = await this.source.listAliveTeamProjections(request.value, context);
      const parsed = parseListAliveTeamProjectionsResult(sourceResult);
      return parsed.ok ? parsed.value : internalFailure('source_response_invalid');
    } catch {
      return internalFailure('unexpected');
    }
  }
}
