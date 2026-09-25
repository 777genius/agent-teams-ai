import {
  type HostedTaskAssignmentCurrentPin,
  type HostedTaskAssignmentCurrentSelector,
  parseHostedTaskAssignmentCurrentPin,
  parseHostedTaskAssignmentCurrentSelector,
} from '../../contracts/hostedTaskAssignmentCurrentContracts';

import type { InternalStorageWorkerTransport } from './InternalStorageWorkerTransport';

/** A single transactional Product writer decision, never a collection of lookup hints. */
export function createHostedTaskAssignmentCurrentWorkerClient(
  call: InternalStorageWorkerTransport['call']
): {
  resolveCurrent(
    input: HostedTaskAssignmentCurrentSelector
  ): Promise<HostedTaskAssignmentCurrentPin | null>;
} {
  return Object.freeze({
    async resolveCurrent(input): Promise<HostedTaskAssignmentCurrentPin | null> {
      const result = await call(
        'hostedTaskAssignment.resolveCurrent',
        parseHostedTaskAssignmentCurrentSelector(input)
      );
      return result === null ? null : parseHostedTaskAssignmentCurrentPin(result);
    },
  });
}
