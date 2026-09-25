import { parseRunId } from '@shared/contracts/hosted';
import {
  parseBootId,
  parseDeploymentId,
  parseRevision,
  parseTeamId,
} from '@shared/contracts/hosted';

import {
  parseHostedLifecycleRunAliasClaim,
  parseHostedLifecycleRunAliasClaimResult,
  parseHostedLifecycleRunReservation,
  parseHostedLifecycleRunReservationInput,
  parseHostedLifecycleRunReservationResult,
} from '../../contracts/hostedLifecycleRunReservationContracts';
import { parseTeamDraftPublicationScope } from '../../contracts/teamDraftPublicationContracts';

import type { HostedLifecycleRunReservationGateway } from '../../contracts/hostedLifecycleRunReservationContracts';
import type { InternalStorageWorkerTransport } from './InternalStorageWorkerTransport';

export function createHostedLifecycleRunReservationWorkerClient(
  call: InternalStorageWorkerTransport['call']
): HostedLifecycleRunReservationGateway {
  return {
    currentPlanGeneration: async (scope) => {
      const result = await call(
        'hostedLifecycleRun.currentPlanGeneration',
        parseTeamDraftPublicationScope(scope)
      );
      if (result === null) return null;
      if (typeof result !== 'string' || !/^plan-generation_[a-f0-9]{64}$/.test(result))
        throw new TypeError('hosted-run-current-plan-generation-invalid');
      return result;
    },
    lookupByResource: async (claim) => {
      const result = await call('hostedLifecycleRun.lookupByResource', {
        deploymentId: parseDeploymentId(claim.deploymentId),
        bootId: parseBootId(claim.bootId),
        teamId: parseTeamId(claim.teamId),
        expectedRevision: parseRevision(claim.expectedRevision),
      });
      return result === null ? null : parseHostedLifecycleRunReservation(result);
    },
    reserve: async (value, options) => {
      const input = parseHostedLifecycleRunReservationInput(value);
      return parseHostedLifecycleRunReservationResult(
        await call('hostedLifecycleRun.reserve', input, {
          signal: options.signal,
          timeoutAtMs: input.deadlineAtMs,
        })
      );
    },
    claimAlias: async (value) =>
      parseHostedLifecycleRunAliasClaimResult(
        await call('hostedLifecycleRun.claimAlias', parseHostedLifecycleRunAliasClaim(value))
      ),
    lookup: async (runId) => {
      const result = await call('hostedLifecycleRun.lookup', parseRunId(runId));
      return result === null ? null : parseHostedLifecycleRunReservation(result);
    },
  };
}
