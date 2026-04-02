import type { CliFlavor, CliFlavorUiOptions } from '@shared/types';

import { configManager } from '../infrastructure/ConfigManager';

export const DEFAULT_CLI_FLAVOR: CliFlavor = 'free-code';

function parseFlavorOverride(raw: string | undefined): CliFlavor | null {
  const trimmed = raw?.trim();
  if (trimmed === 'claude' || trimmed === 'free-code') {
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
  return multimodelEnabled ? 'free-code' : 'claude';
}

export function getCliFlavorUiOptions(flavor: CliFlavor): CliFlavorUiOptions {
  switch (flavor) {
    case 'free-code':
      return {
        displayName: 'free-code-gemini-research',
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
