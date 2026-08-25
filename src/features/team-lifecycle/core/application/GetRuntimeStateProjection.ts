import { createSafeAppError, type QueryContext, type SafeAppError } from '@shared/contracts/hosted';

import {
  type GetRuntimeStateProjectionRequest,
  type GetRuntimeStateProjectionResult,
  parseGetRuntimeStateProjectionRequest,
  parseGetRuntimeStateProjectionResult,
  TEAM_LIFECYCLE_READ_SCHEMA_VERSION,
  type TeamLifecycleReadFailure,
  type TeamLifecycleReadFailureCode,
} from '../../contracts/team-lifecycle-read';

export interface RuntimeStateProjectionReadPort {
  getRuntimeStateProjection(
    request: GetRuntimeStateProjectionRequest,
    context: QueryContext
  ): GetRuntimeStateProjectionResult | Promise<GetRuntimeStateProjectionResult>;
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
      diagnosticId: `team-lifecycle-runtime.${reason}`,
    })
  );
}

export class GetRuntimeStateProjection {
  constructor(private readonly source: RuntimeStateProjectionReadPort) {}

  async execute(
    requestValue: unknown,
    context: QueryContext
  ): Promise<GetRuntimeStateProjectionResult> {
    const request = parseGetRuntimeStateProjectionRequest(requestValue);
    if (!request.ok) return failure(request.error);

    try {
      const sourceResult = await this.source.getRuntimeStateProjection(request.value, context);
      const parsed = parseGetRuntimeStateProjectionResult(sourceResult);
      if (!parsed.ok) return internalFailure('source_response_invalid');
      if (
        parsed.value.kind === 'success' &&
        (parsed.value.projection.workspaceId !== request.value.workspaceId ||
          parsed.value.projection.teamId !== request.value.teamId)
      ) {
        return internalFailure('source_response_invalid');
      }
      return parsed.value;
    } catch {
      return internalFailure('unexpected');
    }
  }
}
