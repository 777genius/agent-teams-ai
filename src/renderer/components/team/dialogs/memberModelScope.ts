import {
  isTeamModelAvailableForUi,
  normalizeExplicitTeamModelForUi,
  type TeamModelRuntimeProviderStatus,
} from '@renderer/utils/teamModelAvailability';
import { normalizeOptionalTeamProviderId } from '@shared/utils/teamProvider';

import type { MemberDraft } from '@renderer/components/team/members/membersEditorTypes';
import type { TeamProviderId } from '@shared/types';

type RuntimeProviderStatusById = ReadonlyMap<
  TeamProviderId,
  TeamModelRuntimeProviderStatus | null | undefined
>;

export function resolveMemberProviderForModelScope(input: {
  memberProviderId?: TeamProviderId;
  selectedProviderId: TeamProviderId;
}): TeamProviderId {
  return normalizeOptionalTeamProviderId(input.memberProviderId) ?? input.selectedProviderId;
}

export function resolveProviderScopedMemberModel(input: {
  memberProviderId?: TeamProviderId;
  memberModel?: string | null;
  selectedProviderId: TeamProviderId;
  runtimeProviderStatusById: RuntimeProviderStatusById;
}): { providerId: TeamProviderId; model: string } {
  const providerId = resolveMemberProviderForModelScope(input);
  const rawModel = input.memberModel?.trim() ?? '';
  if (!rawModel) {
    return { providerId, model: '' };
  }

  const normalizedModel = normalizeExplicitTeamModelForUi(providerId, rawModel);
  if (!normalizedModel) {
    return { providerId, model: '' };
  }

  const providerStatus = input.runtimeProviderStatusById.get(providerId) ?? null;
  if (!isTeamModelAvailableForUi(providerId, normalizedModel, providerStatus)) {
    return { providerId, model: '' };
  }

  return { providerId, model: normalizedModel };
}

export function clearInheritedMemberModelsUnavailableForProvider(input: {
  members: MemberDraft[];
  selectedProviderId: TeamProviderId;
  runtimeProviderStatusById: RuntimeProviderStatusById;
}): { members: MemberDraft[]; changed: boolean } {
  let changed = false;
  const members = input.members.map((member) => {
    if (member.removedAt || member.providerId || !member.model?.trim()) {
      return member;
    }
    if (
      input.selectedProviderId !== 'anthropic' &&
      !input.runtimeProviderStatusById.get(input.selectedProviderId)
    ) {
      return member;
    }

    const scoped = resolveProviderScopedMemberModel({
      memberProviderId: member.providerId,
      memberModel: member.model,
      selectedProviderId: input.selectedProviderId,
      runtimeProviderStatusById: input.runtimeProviderStatusById,
    });
    if (scoped.model) {
      return member;
    }

    changed = true;
    return {
      ...member,
      model: '',
    };
  });

  return { members, changed };
}
