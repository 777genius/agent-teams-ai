import { inferTeamProviderIdFromModel } from '@shared/utils/teamProvider';

import { normalizeTeamProviderLike } from './TeamProvisioningMemberSpecs';
import { resolveOpenCodeSoloRuntimeRecipientProviderId } from './TeamProvisioningOpenCodeSoloRuntime';

import type { OpenCodeRuntimeMessageAdapter } from '../opencode/delivery/OpenCodeMemberMessageDeliveryService';
import type { TeamLaunchRuntimeAdapter, TeamRuntimeProviderId } from '../runtime';
import type { OpenCodeRuntimePermissionListingAdapter } from './TeamProvisioningOpenCodeRuntimePermissions';
import type { TeamConfig, TeamMember, TeamProviderId } from '@shared/types';

export interface OpenCodeRuntimeAdapterRegistryPort {
  has(providerId: TeamRuntimeProviderId): boolean;
  get(providerId: TeamRuntimeProviderId): TeamLaunchRuntimeAdapter;
}

export interface RuntimeRecipientProviderSourcePorts {
  readConfigSnapshot(teamName: string): Promise<TeamConfig | null>;
  readMembersMeta(teamName: string): Promise<readonly TeamMember[]>;
}

export function getOpenCodeRuntimeAdapter(
  registry: OpenCodeRuntimeAdapterRegistryPort | null | undefined
): TeamLaunchRuntimeAdapter | null {
  if (!registry?.has('opencode')) {
    return null;
  }
  return registry.get('opencode');
}

export function getOpenCodeRuntimeMessageAdapter(
  adapter: TeamLaunchRuntimeAdapter | null | undefined
): OpenCodeRuntimeMessageAdapter | null {
  if (
    typeof (adapter as { sendMessageToMember?: unknown } | null | undefined)
      ?.sendMessageToMember !== 'function'
  ) {
    return null;
  }
  return adapter as OpenCodeRuntimeMessageAdapter;
}

export function getOpenCodeRuntimePermissionListingAdapter(
  adapter: TeamLaunchRuntimeAdapter | null | undefined
): OpenCodeRuntimePermissionListingAdapter | null {
  if (
    typeof (adapter as { listRuntimePermissions?: unknown } | null | undefined)
      ?.listRuntimePermissions !== 'function'
  ) {
    return null;
  }
  return adapter as OpenCodeRuntimePermissionListingAdapter;
}

export function resolveRuntimeRecipientProviderIdFromSources(input: {
  memberName: string;
  config: TeamConfig | null | undefined;
  metaMembers: readonly TeamMember[];
}): TeamProviderId | undefined {
  const normalizedMemberName = input.memberName.trim().toLowerCase();
  if (!normalizedMemberName) {
    return undefined;
  }

  const configMember = input.config?.members?.find(
    (member) => member.name?.trim().toLowerCase() === normalizedMemberName
  );
  const metaMember = input.metaMembers.find(
    (member) => member.name?.trim().toLowerCase() === normalizedMemberName
  );
  const configProvider = (configMember as { provider?: unknown } | undefined)?.provider;
  const metaProvider = (metaMember as { provider?: unknown } | undefined)?.provider;

  if (
    !configMember &&
    !metaMember &&
    resolveOpenCodeSoloRuntimeRecipientProviderId({
      memberName: normalizedMemberName,
      config: input.config,
      metaMembers: input.metaMembers,
    }) === 'opencode'
  ) {
    return 'opencode';
  }

  return (
    normalizeTeamProviderLike(metaMember?.providerId) ??
    normalizeTeamProviderLike(metaProvider) ??
    normalizeTeamProviderLike(configMember?.providerId) ??
    normalizeTeamProviderLike(configProvider) ??
    inferTeamProviderIdFromModel(metaMember?.model ?? configMember?.model)
  );
}

export function isOpenCodeRuntimeRecipientFromSources(input: {
  memberName: string;
  config: TeamConfig | null | undefined;
  metaMembers: readonly TeamMember[];
}): boolean {
  return resolveRuntimeRecipientProviderIdFromSources(input) === 'opencode';
}

export async function resolveRuntimeRecipientProviderId(
  input: {
    teamName: string;
    memberName: string;
  },
  ports: RuntimeRecipientProviderSourcePorts
): Promise<TeamProviderId | undefined> {
  const normalizedMemberName = input.memberName.trim().toLowerCase();
  if (!normalizedMemberName) {
    return undefined;
  }

  const [config, metaMembers] = await Promise.all([
    ports.readConfigSnapshot(input.teamName).catch(() => null),
    ports.readMembersMeta(input.teamName).catch(() => []),
  ]);

  return resolveRuntimeRecipientProviderIdFromSources({
    memberName: normalizedMemberName,
    config,
    metaMembers,
  });
}

export async function isOpenCodeRuntimeRecipient(
  input: {
    teamName: string;
    memberName: string;
  },
  ports: RuntimeRecipientProviderSourcePorts
): Promise<boolean> {
  return (await resolveRuntimeRecipientProviderId(input, ports)) === 'opencode';
}
