import { useCallback, useMemo } from 'react';

import { createTeamListLifecyclePorts } from '@features/team-lifecycle/renderer';
import { createTeamListProvisioningPorts } from '@features/team-provisioning/renderer';
import { createTeamListRosterPorts } from '@features/team-roster-mutations/renderer';
import { createTeamListViewReadPorts } from '@features/team-view-read-model/renderer';

import type { TeamLaunchRequest } from '@shared/types';

type TeamRendererLegacyApi = Parameters<typeof createTeamListViewReadPorts>[0] &
  Parameters<typeof createTeamListLifecyclePorts>[0] &
  Parameters<typeof createTeamListProvisioningPorts>[0] &
  Parameters<typeof createTeamListRosterPorts>[0];

/**
 * The list and detail views share these feature-bound ports. Keeping them
 * referentially stable is important because lifecycle reads are effect inputs.
 */
export function useTeamRendererPorts(
  legacyApi: TeamRendererLegacyApi,
  launchTeam: (request: TeamLaunchRequest) => Promise<unknown>
) {
  const read = useMemo(() => createTeamListViewReadPorts(legacyApi), [legacyApi]);
  const lifecycle = useMemo(() => createTeamListLifecyclePorts(legacyApi), [legacyApi]);
  const provisioning = useMemo(
    () => createTeamListProvisioningPorts(legacyApi, { launchTeam }),
    [legacyApi, launchTeam]
  );
  const roster = useMemo(() => createTeamListRosterPorts(legacyApi), [legacyApi]);
  const stopRunningTeam = useCallback(
    (teamName: string) => lifecycle.stopRunningTeam(teamName),
    [lifecycle]
  );

  return { lifecycle, provisioning, read, roster, stopRunningTeam };
}
