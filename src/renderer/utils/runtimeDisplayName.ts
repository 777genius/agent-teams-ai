import type { CliFlavor, CliInstallationStatus } from '@shared/types';

const MULTIMODEL_RUNTIME_LABEL = 'Multimodel runtime';

export function getRuntimeDisplayName(
  cliStatus: Pick<CliInstallationStatus, 'flavor' | 'displayName'> | null | undefined,
  multimodelEnabledFallback = false
): string {
  if (cliStatus?.flavor === 'agent_teams_orchestrator') {
    if (!cliStatus.displayName || cliStatus.displayName === 'agent_teams_orchestrator') {
      return MULTIMODEL_RUNTIME_LABEL;
    }

    return cliStatus.displayName;
  }

  if (cliStatus?.displayName) {
    return cliStatus.displayName;
  }

  return multimodelEnabledFallback ? MULTIMODEL_RUNTIME_LABEL : 'Claude CLI';
}

export function getRuntimeCommandLabel(flavor: CliFlavor): string {
  return flavor === 'agent_teams_orchestrator' ? MULTIMODEL_RUNTIME_LABEL : 'Claude CLI';
}
