import { parseRunId } from '@shared/contracts/hosted';

import {
  parseHostedLifecycleRunReservation,
  parseHostedLifecycleRunReservationInput,
  parseHostedLifecycleRunReservationResult,
} from '../../contracts/hostedLifecycleRunReservationContracts';

import type { HostedLifecycleRunReservationGateway } from '../../contracts/hostedLifecycleRunReservationContracts';
import type { InternalStorageWorkerTransport } from './InternalStorageWorkerTransport';

export function createHostedLifecycleRunReservationWorkerClient(
  call: InternalStorageWorkerTransport['call']
): HostedLifecycleRunReservationGateway {
  return {
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
