import { lstatSync } from 'node:fs';
import { join } from 'node:path';
import { ProviderManagementCoordinator } from './ProviderManagementCoordinator.js';
import { RuntimeSourceIndex } from './RuntimeSourceIndex.js';
import { teamModelProbeProfile } from './teamLaunchModelProbe.js';
import { capturedNativeProcessFactory } from '../adapters/providers/capturedNativeProcessFactory.js';
import { RuntimeSourceNativeVersion } from '../adapters/providers/RuntimeSourceNativeVersion.js';
import type { TeamHostProfile } from './TeamHost.js';
import type { ProviderOAuthSnapshot } from '../management/contracts.js';
import type { RegisteredProcessRootSource } from '../process/registeredProcessContracts.js';
import type { HostWindowsLaunch } from '../owned-process/HostWindowsLaunch.js';

/** Restore source-derived private profiles before existing operation owners read their journals. */
export function createHostProviderManagementComposition(
  profile: TeamHostProfile,
  assertWriter: () => void,
  onOAuthProgress: (snapshot: ProviderOAuthSnapshot) => void,
  processCustody?: RegisteredProcessRootSource,
  assertCleanupWriter = assertWriter,
  retainedWindowsLaunch?: HostWindowsLaunch
) {
  // Presence reads must not create stores before an unrelated Team namespace is admitted.
  // Either retained namespace still requires strict validation after its current seed is removed.
  assertWriter();
  const needsSources =
    Boolean(profile.management?.length) ||
    ['runtime-sources', 'management-commands'].some((name) => {
      try {
        lstatSync(join(profile.owner.storageRoot, name));
        return true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
        throw error;
      }
    });
  assertWriter();
  const createProcess = retainedWindowsLaunch ? capturedNativeProcessFactory(retainedWindowsLaunch) : undefined;
  const sources = needsSources
    ? new RuntimeSourceIndex(profile, assertWriter, {
        assertCleanupWriter,
        ...(processCustody ? { processCustody } : {}),
        ...(createProcess ? { createNativeCheck: (seed, candidate, current) =>
          new RuntimeSourceNativeVersion(seed, candidate, current, processCustody, createProcess) } : {}),
      })
    : undefined;
  const retained = sources?.retainedManagementState() ?? {
    profiles: [],
    unavailable: [],
    hasCommands: false,
  };
  const profiles = [
    ...(profile.management ?? []),
    ...retained.profiles,
    ...(profile.runtime?.members.flatMap((member) => {
      if (
        member.provider === 'opencode' &&
        member.nativeGeneration === 'v2' &&
        !(member.protocolRevision === '2.1.4' && member.embedded)
      )
        return [];
      return [teamModelProbeProfile(member)];
    }) ?? []),
  ];
  const required =
    profiles.length || retained.hasCommands ||
    (profile.creation &&
      profile.runtime?.providerTemplates?.some(
        (row) =>
          row.provider === 'claude' ||
          (row.provider === 'opencode' &&
            row.nativeGeneration === 'v2' &&
            row.protocolRevision === '2.1.4' &&
            row.embedded !== undefined)
      ));
  return {
    sources: profile.management?.length || retained.hasCommands ? sources : undefined,
    management: required
      ? new ProviderManagementCoordinator(profiles, assertWriter, profile.owner.storageRoot, {
          onOAuthProgress,
          unavailableProfiles: retained.unavailable,
          ...(processCustody ? { processCustody } : {}),
          ...(createProcess ? { createProcess } : {}),
        })
      : undefined,
  };
}
