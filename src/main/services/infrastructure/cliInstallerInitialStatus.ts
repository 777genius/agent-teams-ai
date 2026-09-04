import { createDefaultCliExtensionCapabilities } from '@shared/utils/providerExtensionCapabilities';

import { getCliFlavorUiOptions, getConfiguredCliFlavor } from '../team/cliFlavor';

import { FRONTEND_PROVIDER_IDS } from './cliInstallerStatusAuthority';

import type { CliInstallationStatus, CliProviderId } from '@shared/types';

const PROVIDER_DISPLAY_NAMES: Record<CliProviderId, string> = {
  anthropic: 'Anthropic',
  codex: 'Codex',
  gemini: 'Gemini',
  opencode: 'OpenCode (200+ models)',
};

export function createInitialCliInstallationStatus(): CliInstallationStatus {
  const flavor = getConfiguredCliFlavor();
  const ui = getCliFlavorUiOptions(flavor);
  return {
    flavor,
    displayName: ui.displayName,
    supportsSelfUpdate: ui.supportsSelfUpdate,
    showVersionDetails: ui.showVersionDetails,
    showBinaryPath: ui.showBinaryPath,
    installed: false,
    installedVersion: null,
    binaryPath: null,
    launchError: null,
    latestVersion: null,
    updateAvailable: false,
    authLoggedIn: false,
    authStatusChecking: true,
    authMethod: null,
    providers:
      flavor === 'agent_teams_orchestrator'
        ? FRONTEND_PROVIDER_IDS.map((providerId) => ({
            providerId,
            displayName: PROVIDER_DISPLAY_NAMES[providerId],
            supported: false,
            authenticated: false,
            authMethod: null,
            verificationState: 'unknown' as const,
            modelVerificationState: 'idle' as const,
            statusMessage: 'Checking...',
            models: [],
            modelAvailability: [],
            canLoginFromUi: providerId !== 'opencode',
            capabilities: {
              teamLaunch: false,
              oneShot: false,
              extensions: createDefaultCliExtensionCapabilities(),
            },
            backend: null,
          }))
        : [],
  };
}
