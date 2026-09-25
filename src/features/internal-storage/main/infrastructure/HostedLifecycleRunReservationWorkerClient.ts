import { parseRunId } from '@shared/contracts/hosted';

import {
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
    reserve: async (value, options) => {
      const input = parseHostedLifecycleRunReservationInput(value);
      return parseHostedLifecycleRunReservationResult(
        await call('hostedLifecycleRun.reserve', input, {
          signal: options.signal,
          timeoutAtMs: input.deadlineAtMs,
        })
      );
    },
    lookup: async (runId) => {
      const result = await call('hostedLifecycleRun.lookup', parseRunId(runId));
      return result === null ? null : parseHostedLifecycleRunReservation(result);
    },
  };
}
