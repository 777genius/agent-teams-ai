import {
  type OrchestratorLifecycleOwnerBinding,
  requireOrchestratorLifecycleAuthorityRevision,
} from '../../../application/ExecuteHostedLifecycleCommand';

import {
  type OrchestratorLifecycleDurableCommandOutcome,
  type OrchestratorLifecycleResponseAuthority,
  parseOrchestratorLifecycleExecutionResponse,
} from './OrchestratorLifecycleCommandResponses';
import { sameHostedLifecycleAuthorizationFence } from './sameHostedLifecycleAuthorizationFence';

import type { HostedLifecycleCommand } from '../../../../contracts/hosted-lifecycle-commands';
import type {
  HostedLifecycleCommandAuthorization,
  HostedLifecycleCommandGatewayExecutionResult,
} from '../../../../core/application/ports/HostedLifecycleCommandGatewayPort';
import type { OrchestratorLifecycleAuthorizationRegistry } from './orchestratorLifecycleAuthorizationRegistry';

export function createOrchestratorLifecycleCommandOutcomeProjector(
  command: HostedLifecycleCommand,
  authorization: HostedLifecycleCommandAuthorization,
  authorizations: Pick<OrchestratorLifecycleAuthorizationRegistry, 'remember'>
) {
  return Object.freeze({
    validate(
      outcome: ReturnType<typeof parseOrchestratorLifecycleExecutionResponse>,
      authority: OrchestratorLifecycleResponseAuthority,
      ownerBinding: OrchestratorLifecycleOwnerBinding
    ): ReturnType<typeof parseOrchestratorLifecycleExecutionResponse> {
      if (outcome.kind !== 'settled') {
        requireOrchestratorLifecycleAuthorityRevision(authority, authorization.resourceRevision);
        return outcome;
      }
      const settledAuthorization = outcome.execution.authorization;
      requireOrchestratorLifecycleAuthorityRevision(
        authority,
        settledAuthorization.resourceRevision
      );
      if (!sameHostedLifecycleAuthorizationFence(settledAuthorization, authorization)) {
        throw new TypeError('orchestrator-lifecycle-settlement-authorization-invalid');
      }
      if (
        outcome.execution.result.kind === 'conflict' &&
        outcome.execution.result.currentRevision !== settledAuthorization.resourceRevision
      ) {
        throw new TypeError('orchestrator-lifecycle-execution-conflict-revision-invalid');
      }
      authorizations.remember(settledAuthorization, ownerBinding);
      return outcome;
    },
    toGatewayOutcome(
      outcome: OrchestratorLifecycleDurableCommandOutcome
    ): HostedLifecycleCommandGatewayExecutionResult | null {
      if (outcome.kind === 'settled') return outcome.execution;
      if (outcome.kind === 'started' || outcome.kind === 'operator_required') {
        return Object.freeze({ kind: outcome.kind });
      }
      if (outcome.kind === 'idempotency_mismatch') {
        return Object.freeze({
          kind: 'result' as const,
          result: Object.freeze({
            schemaVersion: command.schemaVersion,
            kind: 'conflict' as const,
            action: command.action,
            commandId: command.commandId,
            workspaceId: command.workspaceId,
            teamId: command.teamId,
            reason: 'idempotency_mismatch' as const,
            currentRevision: authorization.resourceRevision,
          }),
          authorization,
        });
      }
      return null;
    },
  });
}
