import { type RuntimeTurnSettledProvider } from '@features/member-work-sync/main';
import { createLogger } from '@shared/utils/logger';
import { inferTeamProviderIdFromModel } from '@shared/utils/teamProvider';

import { resolveTeamProviderId } from '../../runtime/providerRuntimeEnv';
import { type TeamRuntimeSettingsJson } from '../../runtime/teamRuntimeSettingsBundle';

import { normalizeTeamMemberProviderId } from './TeamProvisioningMemberSpecs';

import type { TeamCreateRequest, TeamProviderId } from '@shared/types';

const logger = createLogger('Service:TeamProvisioning');

export interface RuntimeTurnSettledPlanningLogger {
  warn(message: string): void;
}

export type RuntimeTurnSettledHookSettingsProvider = (input: {
  provider: RuntimeTurnSettledProvider;
}) => Promise<Record<string, unknown> | null>;

export type RuntimeTurnSettledEnvironmentProvider = (input: {
  provider: RuntimeTurnSettledProvider;
}) => Promise<Record<string, string> | null>;

export interface RuntimeTurnSettledPlanningPorts {
  hookSettingsProvider?: RuntimeTurnSettledHookSettingsProvider | null;
  environmentProvider?: RuntimeTurnSettledEnvironmentProvider | null;
  logger?: RuntimeTurnSettledPlanningLogger;
}

export async function buildRuntimeTurnSettledHookSettingsObject(
  input: { providerId: TeamProviderId },
  ports: RuntimeTurnSettledPlanningPorts
): Promise<TeamRuntimeSettingsJson | null> {
  if (input.providerId !== 'anthropic' || !ports.hookSettingsProvider) {
    return null;
  }

  try {
    const settings = await ports.hookSettingsProvider({ provider: 'claude' });
    return settings ?? null;
  } catch (error) {
    (ports.logger ?? logger).warn(
      `Failed to build member work sync Stop hook settings: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
    return null;
  }
}

export async function buildRuntimeTurnSettledHookSettingsArgs(
  input: { providerId: TeamProviderId },
  ports: RuntimeTurnSettledPlanningPorts
): Promise<string[]> {
  const settings = await buildRuntimeTurnSettledHookSettingsObject(input, ports);
  return settings ? ['--settings', JSON.stringify(settings)] : [];
}

export async function buildRuntimeTurnSettledEnvironment(
  input: { providerId: TeamProviderId },
  ports: RuntimeTurnSettledPlanningPorts
): Promise<Record<string, string>> {
  if (input.providerId !== 'codex' || !ports.environmentProvider) {
    return {};
  }

  try {
    return (await ports.environmentProvider({ provider: 'codex' })) ?? {};
  } catch (error) {
    (ports.logger ?? logger).warn(
      `Failed to build member work sync runtime turn-settled environment: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
    return {};
  }
}

export async function buildRuntimeTurnSettledEnvironmentForMembers(
  input: {
    primaryProviderId: TeamProviderId | undefined;
    memberSpecs: TeamCreateRequest['members'];
  },
  ports: RuntimeTurnSettledPlanningPorts
): Promise<Record<string, string>> {
  const resolvedPrimaryProviderId = resolveTeamProviderId(input.primaryProviderId);
  const needsCodexTurnSettledEnv = input.memberSpecs.some((member) => {
    const configuredProviderId = normalizeTeamMemberProviderId(member.providerId);
    const inferredProviderId = inferTeamProviderIdFromModel(member.model);
    return (
      resolvedPrimaryProviderId === 'codex' ||
      configuredProviderId === 'codex' ||
      inferredProviderId === 'codex'
    );
  });

  if (!needsCodexTurnSettledEnv) {
    return {};
  }

  return buildRuntimeTurnSettledEnvironment({ providerId: 'codex' }, ports);
}
