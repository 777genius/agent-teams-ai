import {
  getAvailableTeamProviderModels,
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
  // A cold renderer can hydrate saved team members before provider status and
  // the model catalog arrive. Keep the explicit selection until the runtime
  // has enough information to prove it unavailable; otherwise preflight can
  // silently omit a teammate model and launch it with the provider default.
  if (!providerStatus) {
    return { providerId, model: normalizedModel };
  }
  if (
    providerStatus.verificationState === 'error' ||
    providerStatus.modelCatalogRefreshState === 'error'
  ) {
    return { providerId, model: normalizedModel };
  }
  if (!isTeamModelAvailableForUi(providerId, normalizedModel, providerStatus)) {
    return { providerId, model: '' };
  }

  return { providerId, model: normalizedModel };
}

function shouldClearOpenCodeModelToDefault(
  providerId: TeamProviderId,
  providerStatus: TeamModelRuntimeProviderStatus | null | undefined
): boolean {
  if (providerId !== 'opencode' || !providerStatus) {
    return false;
  }
  if (
    providerStatus.modelCatalogRefreshState === 'loading' ||
    providerStatus.modelCatalogRefreshState === 'error' ||
    providerStatus.modelVerificationState === 'verifying' ||
    providerStatus.verificationState === 'error'
  ) {
    return false;
  }
  return getAvailableTeamProviderModels('opencode', providerStatus).length === 0;
}

export function clearInheritedMemberModelsUnavailableForProvider(input: {
  members: MemberDraft[];
  selectedProviderId: TeamProviderId;
  runtimeProviderStatusById: RuntimeProviderStatusById;
}): { members: MemberDraft[]; changed: boolean } {
  let changed = false;
  const members = input.members.map((member) => {
    if (member.removedAt || !member.model?.trim()) {
      return member;
    }
    const providerId = resolveMemberProviderForModelScope({
      memberProviderId: member.providerId,
      selectedProviderId: input.selectedProviderId,
    });
    const providerStatus = input.runtimeProviderStatusById.get(providerId) ?? null;
    if (shouldClearOpenCodeModelToDefault(providerId, providerStatus)) {
      changed = true;
      return {
        ...member,
        model: '',
      };
    }
    if (member.providerId) {
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
