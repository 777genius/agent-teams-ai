import { createQueryContext } from '@shared/contracts/hosted';

import type { TeamLifecycleReadAuthority } from './composition/hosted/teamLifecycleReadComposition';

let requestSequence = 0;

export const teamLifecycleReadNowMs = (): number => Date.now();

export function createTeamLifecycleReadQueryContext(
  authority: TeamLifecycleReadAuthority,
  requestSignal: AbortSignal
) {
  return createQueryContext({
    actorId: authority.actorId,
    sessionId: 'session_team-lifecycle-read-standalone',
    deploymentId: authority.deploymentId,
    bootId: authority.bootId,
    requestId: `request_team-lifecycle-read-standalone-${++requestSequence}`,
    authorizedScope: authority.authorizedScope,
    deadlineAtMs: teamLifecycleReadNowMs() + 10_000,
    signal: requestSignal,
  });
}
