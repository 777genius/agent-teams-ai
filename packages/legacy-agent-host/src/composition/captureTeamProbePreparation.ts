import { TeamLaunchError } from '../team-launch/contracts.js';
import type { ProviderManagementProfile } from '../management/profile.js';
import type { ProviderManagementCoordinator } from './ProviderManagementCoordinator.js';
import type { RuntimeSourceProcessOrigin } from './runtimeSourceProcessOrigin.js';

/** Only affected private V1 profiles change identity; old ambiguous execution proofs remain held. */
export const V1_NATIVE_MODEL_PROBE_PREFIX = 'team-probe-v1-native-model-';
export function hasV1NativeModelProbeIdentity(profile: ProviderManagementProfile): boolean {
  return profile.provider === 'opencode' && profile.nativeGeneration !== 'v2' &&
    profile.profileId === profile.configRevision &&
    profile.profileId.startsWith(V1_NATIVE_MODEL_PROBE_PREFIX) &&
    /^[a-f0-9]{64}$/u.test(profile.profileId.slice(V1_NATIVE_MODEL_PROBE_PREFIX.length));
}

export type TeamProbeManagement = Pick<ProviderManagementCoordinator, 'admitTeamProbeProfile' | 'probes'> &
  Partial<Pick<ProviderManagementCoordinator, 'prepareTeamProbe'>>;

/** No factory is captured here on replay; the existing owner invokes this only after admission. */
export function captureTeamProbePreparation(management: TeamProbeManagement,
  profile: ProviderManagementProfile, origin?: RuntimeSourceProcessOrigin) {
  if ((origin || hasV1NativeModelProbeIdentity(profile)) && !management.prepareTeamProbe)
    throw new TeamLaunchError('hold', 'probe-source-owner');
  return management.prepareTeamProbe?.(profile, origin);
}
