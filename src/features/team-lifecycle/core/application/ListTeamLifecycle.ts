import { createSafeAppError, type SafeAppError } from '@shared/contracts/hosted';

import {
  type ListTeamLifecycleFailure,
  type ListTeamLifecycleRequest,
  type ListTeamLifecycleResult,
  parseListTeamLifecycleRequest,
  parseListTeamLifecycleResult,
  TEAM_LIFECYCLE_READ_SCHEMA_VERSION,
  type TeamLifecycleReadFailureCode,
} from '../../contracts';

export interface TeamLifecycleReadSource {
  listTeamLifecycle(
    request: ListTeamLifecycleRequest
  ): ListTeamLifecycleResult | Promise<ListTeamLifecycleResult>;
}

function failure(error: SafeAppError): ListTeamLifecycleFailure {
  return Object.freeze({
    schemaVersion: TEAM_LIFECYCLE_READ_SCHEMA_VERSION,
    kind: 'failure',
    error: error as SafeAppError & { readonly code: TeamLifecycleReadFailureCode },
    retryable: error.code === 'unavailable',
  });
}

function internalFailure(
  reason: 'source_response_invalid' | 'unexpected',
  diagnosticId: string
): ListTeamLifecycleFailure {
  return failure(createSafeAppError({ code: 'internal', reason, diagnosticId }));
}

export class ListTeamLifecycle {
  constructor(private readonly source: TeamLifecycleReadSource) {}

  async execute(requestValue: unknown): Promise<ListTeamLifecycleResult> {
    const request = parseListTeamLifecycleRequest(requestValue);
    if (!request.ok) return failure(request.error);

    try {
      const sourceResult = await this.source.listTeamLifecycle(request.value);
      const parsedResult = parseListTeamLifecycleResult(sourceResult);
      if (!parsedResult.ok) {
        return internalFailure(
          'source_response_invalid',
          'team-lifecycle-read.source-response-invalid'
        );
      }
      return parsedResult.value;
    } catch {
      return internalFailure('unexpected', 'team-lifecycle-read.unexpected');
    }
  }
}
