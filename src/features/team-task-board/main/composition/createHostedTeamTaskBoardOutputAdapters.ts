import { HostedTaskBoardAuthorityAdapter } from '../adapters/output/HostedTaskBoardAuthorityAdapter';

import type { HostedTaskBoardPageSourcePort } from '../../core/application/ports/HostedTeamTaskBoardPorts';
import type { HostedTaskBoardAuthorityPort } from '../ports/HostedTaskBoardAuthorityPort';

export interface HostedTeamTaskBoardOutputAdapters {
  readonly pageSource: HostedTaskBoardPageSourcePort;
}

export function createHostedTeamTaskBoardOutputAdapters(
  authority: HostedTaskBoardAuthorityPort
): HostedTeamTaskBoardOutputAdapters {
  const adapter = new HostedTaskBoardAuthorityAdapter(authority);
  return Object.freeze({ pageSource: adapter });
}
