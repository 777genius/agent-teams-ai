import { configManager } from '../infrastructure/ConfigManager';

import type { CliFlavor, CliFlavorUiOptions } from '@shared/types';

export const DEFAULT_CLI_FLAVOR: CliFlavor = 'agent_teams_orchestrator';

function parseFlavorOverride(raw: string | undefined): CliFlavor | null {
  const trimmed = raw?.trim();
  if (trimmed === 'claude' || trimmed === 'agent_teams_orchestrator') {
    return trimmed;
  }
  return null;
}

export function getConfiguredCliFlavor(): CliFlavor {
  const envOverride = parseFlavorOverride(process.env.CLAUDE_TEAM_CLI_FLAVOR);
  if (envOverride) {
    return envOverride;
  }

  const multimodelEnabled = configManager.getConfig().general.multimodelEnabled;
  return multimodelEnabled ? 'agent_teams_orchestrator' : 'claude';
}

export function getCliFlavorUiOptions(flavor: CliFlavor): CliFlavorUiOptions {
  switch (flavor) {
    case 'agent_teams_orchestrator':
      return {
        displayName: 'Multimodel runtime',
        supportsSelfUpdate: false,
        showVersionDetails: false,
        showBinaryPath: false,
      };
    case 'claude':
    default:
      return {
        displayName: 'Claude CLI',
        supportsSelfUpdate: true,
        showVersionDetails: true,
        showBinaryPath: true,
      };
  }
}

export function getCliFlavorCommandLabel(flavor: CliFlavor): string {
  switch (flavor) {
    case 'agent_teams_orchestrator':
      return 'orchestrator-cli';
    case 'claude':
    default:
      return 'claude';
  }
}

export function getConfiguredCliCommandLabel(): string {
  return getCliFlavorCommandLabel(getConfiguredCliFlavor());
}
