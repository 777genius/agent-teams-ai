import type { TeamLaunchFailureDiagnosticsBundle } from '../models/TeamProvisioningModels';
import type { TeamLaunchDiagnosticsPort } from '../ports/TeamProvisioningPorts';

export class ReadLaunchDiagnostics {
  constructor(private readonly diagnostics: TeamLaunchDiagnosticsPort) {}

  execute(teamName: string, runId?: string): Promise<TeamLaunchFailureDiagnosticsBundle> {
    return this.diagnostics.read(teamName, runId);
  }
}
