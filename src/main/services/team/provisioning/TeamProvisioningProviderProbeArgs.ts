import { buildProviderPreflightPingArgs } from '../../runtime/providerModelProbe';
import { resolveTeamProviderId } from '../../runtime/providerRuntimeEnv';

import type { TeamProviderId, TeamProvisioningModelCheckRequest } from '@shared/types';

interface ProviderPreflightPingArgsPorts {
  getConfiguredCodexCustomProviderModel(): string | null;
}

export function getProviderPreflightPingArgs(
  providerId: TeamProviderId | undefined,
  ports: ProviderPreflightPingArgsPorts,
  exactCheck?: TeamProvisioningModelCheckRequest
): string[] {
  const customModel =
    resolveTeamProviderId(providerId) === 'codex'
      ? ports.getConfiguredCodexCustomProviderModel()
      : null;
  const args = buildProviderPreflightPingArgs(providerId, {
    modelOverride: exactCheck?.model ?? customModel,
  });
  if (exactCheck?.effort) args.push('--effort', exactCheck.effort);
  return args;
}
