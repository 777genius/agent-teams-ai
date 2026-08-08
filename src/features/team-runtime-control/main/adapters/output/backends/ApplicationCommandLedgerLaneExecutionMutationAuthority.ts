import {
  ApplicationCommandFailureKind,
  type ApplicationCommandJsonValue,
  type ApplicationCommandResultClassification,
  type ApplicationCommandRunner,
} from '@features/application-command-ledger';

import {
  isLaneExecutionOperationRejectionReason,
  LaneExecutionMutationAuthority,
  LaneExecutionMutationAuthorityRequest,
  type LaneExecutionMutationEffectKind,
  parseLaneExecutionRef,
} from '../../../../core/application/backends';

export const LANE_EXECUTION_MUTATION_NAMESPACE = 'lane-execution-mutation';

/**
 * Adapts the application-command runner to the lane mutation boundary. The
 * runner supplies canonical payload hashing and completed-result replay; its
 * storage begin transaction owns the durable lease/fence claim.
 */
export class ApplicationCommandLedgerLaneExecutionMutationAuthority implements LaneExecutionMutationAuthority {
  constructor(private readonly runner: ApplicationCommandRunner) {}

  async execute<TResult>(
    request: LaneExecutionMutationAuthorityRequest,
    effect: () => Promise<TResult>
  ): Promise<TResult> {
    const scope = request.payload.scope;
    if (
      request.effectKind !== request.payload.effectKind ||
      request.backend !== scope.executionUnit.backendBinding.backend ||
      scope.lane.laneId !== scope.executionUnit.laneId
    ) {
      throw new TypeError('lane-execution-mutation-authority-binding-mismatch');
    }

    const result = await this.runner.run(
      {
        namespace: LANE_EXECUTION_MUTATION_NAMESPACE,
        scopeKey: [scope.plan.teamId, scope.plan.runId, String(scope.plan.generation)].join(':'),
        commandId: request.operationId,
        idempotencyKey: request.operationId,
        operation: `lane-execution.${request.effectKind}`,
        payload: request.payload as unknown as ApplicationCommandJsonValue,
        mutationFence: {
          laneId: scope.lane.laneId,
          backend: request.backend,
          effectKind: request.effectKind,
          operationId: request.operationId,
          leaseToken: request.effectLease.token,
          leaseOwnerId: request.effectLease.ownerId,
          leaseFence: request.effectLease.fence,
          claimedAtIso: request.effectLease.claimedAtIso,
          expiresAtIso: request.effectLease.expiresAtIso,
        },
        classifyError: () => ({
          failureKind: ApplicationCommandFailureKind.UnknownAfterTimeout,
        }),
        classifyResult: (providerResult) =>
          classifyProviderMutationResult(request.effectKind, providerResult),
      },
      async () => (await effect()) as ApplicationCommandJsonValue
    );
    return (
      classifyProviderMutationResult(request.effectKind, result.result).outcome === 'unknown'
        ? { status: 'operator_required' }
        : result.result
    ) as TResult;
  }
}

function classifyProviderMutationResult(
  effectKind: LaneExecutionMutationEffectKind,
  result: unknown
): ApplicationCommandResultClassification {
  if (!isExactRecord(result, ['status']) && !isExactRecord(result, ['reason', 'status'])) {
    if (
      (effectKind === 'launch' || effectKind === 'recover') &&
      isExactRecord(result, ['executionRef', 'status'])
    ) {
      try {
        parseLaneExecutionRef(result.executionRef);
      } catch {
        return {
          outcome: 'unknown',
          message: 'Provider mutation returned an invalid executionRef',
        };
      }
      const expectedStatus =
        effectKind === 'launch' ? ['launched', 'already_launched'] : ['recovered'];
      return expectedStatus.includes(result.status as string)
        ? { outcome: 'completed' }
        : { outcome: 'unknown', message: 'Provider mutation returned a malformed result' };
    }
    return { outcome: 'unknown', message: 'Provider mutation returned a malformed result' };
  }
  if (result.status === 'operator_required') {
    return {
      outcome: 'unknown',
      message: 'Provider mutation requires operator reconciliation',
    };
  }
  if (result.status === 'rejected') {
    return isLaneExecutionOperationRejectionReason(result.reason)
      ? { outcome: 'completed' }
      : { outcome: 'unknown', message: 'Provider mutation returned a malformed rejection' };
  }
  const completedStatuses =
    effectKind === 'stop'
      ? ['stopped', 'already_stopped', 'cancelled']
      : effectKind === 'recover'
        ? ['not_started', 'cancelled']
        : [];
  return completedStatuses.includes(result.status as string)
    ? { outcome: 'completed' }
    : { outcome: 'unknown', message: 'Provider mutation returned a malformed result' };
}

function isExactRecord(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  const actualKeys = Object.keys(value);
  return actualKeys.length === keys.length && actualKeys.every((key) => keys.includes(key));
}
