import { migrateProviderBackendId } from '@shared/utils/providerBackend';
import { normalizeTeamMemberMcpPolicy } from '@shared/utils/teamMemberMcpPolicy';

import { resolveTeamProviderId } from '../../runtime/providerRuntimeEnv';

import {
  buildEffectiveTeamMemberSpec,
  normalizeTeamMemberProviderId,
} from './TeamProvisioningMemberSpecs';

import type { EffectiveConfiguredMember } from './TeamProvisioningMemberStatusProjection';
import type { TeamCreateRequest } from '@shared/types';

type ProvisioningMemberSpec = TeamCreateRequest['members'][number];

type PrimaryOwnedRuntimeDefaults = Pick<
  TeamCreateRequest,
  'providerId' | 'providerBackendId' | 'model' | 'effort' | 'fastMode'
>;

export function buildConfiguredProvisioningMember(
  configuredMember: EffectiveConfiguredMember
): ProvisioningMemberSpec {
  return {
    name: configuredMember.name,
    ...(configuredMember.role ? { role: configuredMember.role } : {}),
    ...(configuredMember.workflow ? { workflow: configuredMember.workflow } : {}),
    ...(configuredMember.isolation === 'worktree' ? { isolation: 'worktree' as const } : {}),
    ...(configuredMember.cwd ? { cwd: configuredMember.cwd } : {}),
    ...(configuredMember.providerId ? { providerId: configuredMember.providerId } : {}),
    ...(configuredMember.providerBackendId
      ? { providerBackendId: configuredMember.providerBackendId }
      : {}),
    ...(configuredMember.model ? { model: configuredMember.model } : {}),
    ...(configuredMember.effort ? { effort: configuredMember.effort } : {}),
    ...(configuredMember.fastMode ? { fastMode: configuredMember.fastMode } : {}),
    ...(configuredMember.mcpPolicy
      ? { mcpPolicy: normalizeTeamMemberMcpPolicy(configuredMember.mcpPolicy) }
      : {}),
  };
}

export function buildPrimaryOwnedMemberSpecForRuntime(input: {
  configuredMember: EffectiveConfiguredMember;
  request: PrimaryOwnedRuntimeDefaults;
}): ProvisioningMemberSpec {
  const configuredSpec = buildConfiguredProvisioningMember(input.configuredMember);
  const defaultProviderId = resolveTeamProviderId(input.request.providerId);
  const memberProviderId = normalizeTeamMemberProviderId(configuredSpec.providerId);
  const inheritsDefaultRuntime =
    memberProviderId == null || memberProviderId === defaultProviderId;
  const effectiveSpec = buildEffectiveTeamMemberSpec(configuredSpec, {
    providerId: defaultProviderId,
    model: input.request.model,
    effort: input.request.effort,
  });
  const effectiveProviderId = resolveTeamProviderId(effectiveSpec.providerId);
  const providerBackendId =
    migrateProviderBackendId(effectiveProviderId, configuredSpec.providerBackendId) ??
    (inheritsDefaultRuntime
      ? migrateProviderBackendId(effectiveProviderId, input.request.providerBackendId)
      : undefined);
  const fastMode =
    configuredSpec.fastMode ?? (inheritsDefaultRuntime ? input.request.fastMode : undefined);

  return {
    ...effectiveSpec,
    ...(providerBackendId ? { providerBackendId } : {}),
    ...(fastMode ? { fastMode } : {}),
    ...(input.configuredMember.agentType ? { agentType: input.configuredMember.agentType } : {}),
  };
}
