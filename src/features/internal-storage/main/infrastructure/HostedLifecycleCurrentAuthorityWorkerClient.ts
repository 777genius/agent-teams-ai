import { parseDeploymentId, parseRunId } from '@shared/contracts/hosted';

import {
  parseHostedLifecycleCurrentAuthority,
  parseHostedLifecycleCurrentMutationResult,
  parseHostedLifecycleCurrentRun,
  parseHostedLifecycleCurrentTeamSelector,
  parseHostedLifecycleEpochUpdate,
  parseHostedLifecycleMemberRetirement,
  parseHostedLifecycleRunStateChange,
} from '../../contracts/hostedLifecycleCurrentAuthorityContracts';

import type { HostedLifecycleCurrentAuthorityGateway } from '../../contracts/hostedLifecycleCurrentAuthorityContracts';
import type { InternalStorageWorkerTransport } from './InternalStorageWorkerTransport';

function parseDisposition(value: unknown, allowed: readonly string[]): never | string {
  if (typeof value !== 'string' || !allowed.includes(value))
    throw new TypeError('hosted-lifecycle-current-disposition-invalid');
  return value;
}

/** Private Product writer surface; never exposed through IPC or HTTP. */
export function createHostedLifecycleCurrentAuthorityWorkerClient(
  call: InternalStorageWorkerTransport['call']
): HostedLifecycleCurrentAuthorityGateway {
  const client: HostedLifecycleCurrentAuthorityGateway = {
    async lookupAuthority(deploymentId) {
      const result = await call(
        'hostedLifecycleCurrent.lookupAuthority',
        parseDeploymentId(deploymentId)
      );
      return result === null ? null : parseHostedLifecycleCurrentAuthority(result);
    },
    async lookupRun(runId) {
      const result = await call('hostedLifecycleCurrent.lookupRun', parseRunId(runId));
      return result === null ? null : parseHostedLifecycleCurrentRun(result);
    },
    async lookupTeamRun(input) {
      const result = await call(
        'hostedLifecycleCurrent.lookupTeamRun',
        parseHostedLifecycleCurrentTeamSelector(input)
      );
      return result === null ? null : parseHostedLifecycleCurrentRun(result);
    },
    async setCurrentAuthority(input) {
      return parseHostedLifecycleCurrentMutationResult(
        await call('hostedLifecycleCurrent.setAuthority', parseHostedLifecycleEpochUpdate(input))
      );
    },
    async retireAuthority(input) {
      return parseHostedLifecycleCurrentMutationResult(
        await call('hostedLifecycleCurrent.retireAuthority', parseHostedLifecycleEpochUpdate(input))
      );
    },
    async activateReservedRun(input) {
      return parseDisposition(
        await call('hostedLifecycleCurrent.activateRun', parseHostedLifecycleRunStateChange(input)),
        ['activated', 'already_current', 'conflict']
      ) as 'activated' | 'already_current' | 'conflict';
    },
    async retireRun(input) {
      return parseDisposition(
        await call('hostedLifecycleCurrent.retireRun', parseHostedLifecycleRunStateChange(input)),
        ['cleanup_pending', 'already_pending', 'already_retired', 'conflict']
      ) as 'cleanup_pending' | 'already_pending' | 'already_retired' | 'conflict';
    },
    async confirmRunRetired(input) {
      return parseDisposition(
        await call(
          'hostedLifecycleCurrent.confirmRunRetired',
          parseHostedLifecycleRunStateChange(input)
        ),
        ['retired', 'already_retired', 'conflict']
      ) as 'retired' | 'already_retired' | 'conflict';
    },
    async retireMember(input) {
      return parseDisposition(
        await call(
          'hostedLifecycleCurrent.retireMember',
          parseHostedLifecycleMemberRetirement(input)
        ),
        ['retired', 'already_retired', 'conflict']
      ) as 'retired' | 'already_retired' | 'conflict';
    },
  };
  return Object.freeze(client);
}
