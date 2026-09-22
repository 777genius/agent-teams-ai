import { filterMainScreenCliProviders } from './geminiUiFreeze';

import type {
  CliExtensionCapability,
  CliInstallationStatus,
  CliProviderStatus,
} from '@shared/types';

export function getVisibleMultimodelProviders(
  providers: readonly CliProviderStatus[]
): CliProviderStatus[] {
  return filterMainScreenCliProviders(providers);
}

export function isMultimodelRuntimeStatus(
  cliStatus: Pick<CliInstallationStatus, 'flavor' | 'providers'> | null | undefined
): boolean {
  return cliStatus?.flavor === 'agent_teams_orchestrator';
}

export function formatCliExtensionCapabilityStatus(
  status: CliExtensionCapability['status']
): string {
  switch (status) {
    case 'supported':
      return 'supported';
    case 'read-only':
      return 'read-only';
    default:
      return 'unsupported';
  }
}
