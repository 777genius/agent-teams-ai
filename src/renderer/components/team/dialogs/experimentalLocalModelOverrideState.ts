import type { ProvisioningProviderCheck } from './ProvisioningProviderStatusList';

export function resolveExperimentalLocalModelOverride(input: {
  active?: boolean;
  checks: readonly ProvisioningProviderCheck[];
  checked: boolean;
}): { available: boolean; enabled: boolean } {
  const failedChecks = input.checks.filter((check) => check.status === 'failed');
  const available =
    input.active !== false &&
    failedChecks.length > 0 &&
    failedChecks.every((check) => check.experimentalOverrideAvailable === true);
  return { available, enabled: available && input.checked };
}
