import type { TeamLaunchDiagnosticsPort } from '../ports/TeamProvisioningPorts';
import type { TeamLaunchFailureDiagnosticsBundle } from '@shared/types';

export class ReadLaunchDiagnostics {
  constructor(private readonly diagnostics: TeamLaunchDiagnosticsPort) {}

  execute(teamName: string, runId?: string): Promise<TeamLaunchFailureDiagnosticsBundle> {
    return this.diagnostics.read(teamName, runId);
  }
}
