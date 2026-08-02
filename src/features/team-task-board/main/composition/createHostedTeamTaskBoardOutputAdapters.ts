import { HostedTaskBoardAuthorityAdapter } from '../adapters/output/HostedTaskBoardAuthorityAdapter';

import type {
  HostedTaskBoardPageSourcePort,
  HostedTaskMutationAdmissionPort,
} from '../../core/application/ports/HostedTeamTaskBoardPorts';
import type { HostedTaskBoardAuthorityPort } from '../ports/HostedTaskBoardAuthorityPort';

export interface HostedTeamTaskBoardOutputAdapters {
  readonly pageSource: HostedTaskBoardPageSourcePort;
  readonly mutationAdmission: HostedTaskMutationAdmissionPort;
}

export function createHostedTeamTaskBoardOutputAdapters(
  authority: HostedTaskBoardAuthorityPort
): HostedTeamTaskBoardOutputAdapters {
  const adapter = new HostedTaskBoardAuthorityAdapter(authority);
  return Object.freeze({ pageSource: adapter, mutationAdmission: adapter });
}
