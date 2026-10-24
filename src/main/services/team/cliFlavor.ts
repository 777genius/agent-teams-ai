import type { CliFlavor, CliFlavorUiOptions } from '@shared/types';

export const DEFAULT_CLI_FLAVOR: CliFlavor = 'agent_teams_orchestrator';

/** Always use the orchestrator; native Claude is a provider, not an alternate app runtime. */
export function getConfiguredCliFlavor(): CliFlavor {
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
