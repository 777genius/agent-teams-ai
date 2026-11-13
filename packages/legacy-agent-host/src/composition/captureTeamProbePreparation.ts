import { TeamLaunchError } from '../team-launch/contracts.js';
import type { ProviderManagementProfile } from '../management/profile.js';
import type { ProviderManagementCoordinator } from './ProviderManagementCoordinator.js';
import type { RuntimeSourceProcessOrigin } from './runtimeSourceProcessOrigin.js';

export type TeamProbeManagement = Pick<ProviderManagementCoordinator, 'admitTeamProbeProfile' | 'probes'> &
  Partial<Pick<ProviderManagementCoordinator, 'prepareTeamProbe'>>;

/** No factory is captured here on replay; the existing owner invokes this only after admission. */
export function captureTeamProbePreparation(management: TeamProbeManagement,
  profile: ProviderManagementProfile, origin?: RuntimeSourceProcessOrigin) {
  if (origin && !management.prepareTeamProbe) throw new TeamLaunchError('hold', 'probe-source-owner');
  return management.prepareTeamProbe?.(profile, origin);
}
