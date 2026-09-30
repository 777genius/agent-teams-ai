import type { CliFlavor, CliFlavorUiOptions } from '@shared/types';

export const DEFAULT_CLI_FLAVOR: CliFlavor = 'agent_teams_orchestrator';

export function getConfiguredCliFlavor(): CliFlavor {
  // Native Claude is a provider within the orchestrator; legacy runtime overrides are disabled.
  return DEFAULT_CLI_FLAVOR;
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
