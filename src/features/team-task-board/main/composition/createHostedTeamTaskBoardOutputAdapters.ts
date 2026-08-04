import { HostedTaskBoardAuthorityAdapter } from '../adapters/output/HostedTaskBoardAuthorityAdapter';
import { HostedTaskBoardMutationAuthorityAdapter } from '../adapters/output/HostedTaskBoardMutationAuthorityAdapter';

import type {
  HostedTaskBoardPageSourcePort,
  HostedTaskMutationAdmissionPort,
} from '../../core/application/ports/HostedTeamTaskBoardPorts';
import type { HostedTaskBoardAuthorityPort } from '../ports/HostedTaskBoardAuthorityPort';

export interface HostedTeamTaskBoardOutputAdapters {
  readonly pageSource: HostedTaskBoardPageSourcePort;
  /** Absent until a host supplies the generation-first mutation authority. */
  readonly mutationAdmission?: HostedTaskMutationAdmissionPort;
}

export function createHostedTeamTaskBoardOutputAdapters(
  authority: HostedTaskBoardAuthorityPort
): HostedTeamTaskBoardOutputAdapters {
  const pageSource = new HostedTaskBoardAuthorityAdapter(authority);
  if (typeof authority.admitTaskMutation !== 'function') return Object.freeze({ pageSource });

  const mutationAdmission = new HostedTaskBoardMutationAuthorityAdapter(authority);
  return Object.freeze({ pageSource, mutationAdmission });
}
