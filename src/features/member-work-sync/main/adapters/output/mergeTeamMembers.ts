import {
  inferTeamProviderIdFromModel,
  normalizeOptionalTeamProviderId,
} from '@shared/utils/teamProvider';

import { normalizeMemberName } from '../../../core/domain';

import type { TeamMember, TeamProviderId } from '@shared/types';

function memberKey(member: Pick<TeamMember, 'name'>): string {
  return normalizeMemberName(member.name);
}

const PROVIDER_SCOPED_MEMBER_FIELDS = new Set<keyof TeamMember>([
  'providerId',
  'providerBackendId',
  'model',
  'effort',
  'fastMode',
]);

const PROVIDER_SETTING_MEMBER_FIELDS = new Set<keyof TeamMember>(['effort', 'fastMode']);

function hasProviderIdentityFields(member: TeamMember | undefined): boolean {
  return providerIdForMember(member) !== undefined;
}

function inferProviderIdFromBackend(providerBackendId: unknown): TeamProviderId | undefined {
  const normalized = typeof providerBackendId === 'string' ? providerBackendId.trim() : '';
  if (normalized === 'codex-native') {
    return 'codex';
  }
  if (normalized === 'opencode-cli') {
    return 'opencode';
  }
  return undefined;
}

function providerIdForMember(member: TeamMember | undefined): TeamProviderId | undefined {
  return (
    normalizeOptionalTeamProviderId(member?.providerId) ??
    inferProviderIdFromBackend(member?.providerBackendId) ??
    inferTeamProviderIdFromModel(member?.model)
  );
}

function shouldPreserveBaseProviderScopedField(
  base: TeamMember | undefined,
  key: keyof TeamMember
): boolean {
  if (!base || !PROVIDER_SCOPED_MEMBER_FIELDS.has(key)) {
    return false;
  }
  if (hasProviderIdentityFields(base)) {
    return true;
  }
  return PROVIDER_SETTING_MEMBER_FIELDS.has(key) && base[key] !== undefined;
}

function mergeDefinedMemberFields(base: TeamMember | undefined, overlay: TeamMember): TeamMember {
  const merged: TeamMember = { ...(base ?? { name: overlay.name }) };
  const overlayProviderId = normalizeOptionalTeamProviderId(overlay.providerId);
  const overlayHasProviderId = overlayProviderId !== undefined;
  const baseProviderId = providerIdForMember(base);
  const providerChanged =
    overlayHasProviderId && baseProviderId !== undefined && overlayProviderId !== baseProviderId;
  if (providerChanged) {
    for (const key of PROVIDER_SCOPED_MEMBER_FIELDS) {
      delete merged[key];
    }
  }
  for (const [key, value] of Object.entries(overlay) as [
    keyof TeamMember,
    TeamMember[keyof TeamMember],
  ][]) {
    if (value !== undefined) {
      if (!overlayHasProviderId && shouldPreserveBaseProviderScopedField(base, key)) {
        continue;
      }
      merged[key] = value as never;
    }
  }
  if (
    Object.prototype.hasOwnProperty.call(overlay, 'removedAt') &&
    overlay.removedAt === undefined
  ) {
    delete merged.removedAt;
  }
  return merged;
}

export function mergeTeamMembers(
  configMembers: TeamMember[],
  metaMembers: TeamMember[]
): TeamMember[] {
  const byName = new Map<string, TeamMember>();
  for (const member of configMembers) {
    const key = memberKey(member);
    if (key) {
      byName.set(key, member);
    }
  }
  for (const member of metaMembers) {
    const key = memberKey(member);
    if (key) {
      byName.set(key, mergeDefinedMemberFields(byName.get(key), member));
    }
  }
  return [...byName.values()];
}
