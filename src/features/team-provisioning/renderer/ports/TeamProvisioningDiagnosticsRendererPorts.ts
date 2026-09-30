import type { TeamLaunchFailureDiagnosticsBundle } from '@shared/types';
import type { CliArgsValidationResult } from '@shared/utils/cliArgsParser';

export interface TeamProvisioningDiagnosticsRendererPorts {
  getLaunchFailureDiagnostics(
    teamName: string,
    runId?: string
  ): Promise<TeamLaunchFailureDiagnosticsBundle>;
  validateCliArgs(rawArgs: string): Promise<CliArgsValidationResult>;
}
