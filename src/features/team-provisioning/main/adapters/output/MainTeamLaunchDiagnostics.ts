import { readTeamLaunchFailureDiagnosticsBundle } from '@main/services/team/TeamLaunchFailureArtifactPack';

import type { TeamLaunchDiagnosticsPort } from '../../../core/application/ports/TeamProvisioningPorts';
import type { TeamLaunchFailureDiagnosticsBundle } from '@shared/types';

export class MainTeamLaunchDiagnostics implements TeamLaunchDiagnosticsPort {
  read(teamName: string, runId?: string): Promise<TeamLaunchFailureDiagnosticsBundle> {
    return readTeamLaunchFailureDiagnosticsBundle(teamName, runId);
  }
}
