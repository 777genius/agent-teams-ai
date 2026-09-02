import {
  getAvailableTeamProviderModels,
  getTeamModelSelectionError,
  hasTerminalAuthoritativeModelVerification,
  isTeamModelAvailableForUi,
  isTeamProviderModelCatalogFresh,
  normalizeExplicitTeamModelForUi,
  type TeamModelRuntimeProviderStatus,
} from '@renderer/utils/teamModelAvailability';
import { parseOpenCodeQualifiedModelRef } from '@shared/utils/opencodeModelRef';
import { isOpenCodeLocalProviderId } from '@shared/utils/opencodeModelRoute';
import { normalizeOptionalTeamProviderId } from '@shared/utils/teamProvider';

import type { MemberDraft } from '@renderer/components/team/members/membersEditorTypes';
import type { TeamProviderId } from '@shared/types';

type RuntimeProviderStatusById = ReadonlyMap<
  TeamProviderId,
  TeamModelRuntimeProviderStatus | null | undefined
>;
type RuntimeProviderLoadingById = ReadonlyMap<TeamProviderId, boolean | undefined>;
type OpenCodeProviderScopedStatusBySourceId = ReadonlyMap<
  string,
  TeamModelRuntimeProviderStatus | null | undefined
>;

interface OpenCodeLocalModelScope {
  openCodeLocalProviderIds?: ReadonlySet<string>;
  openCodeLocalProviderLookupAuthoritative?: boolean;
}

interface OpenCodeProviderCatalogScope {
  openCodeProviderScopedStatusBySourceId?: OpenCodeProviderScopedStatusBySourceId;
}

function getModelScopedProviderStatus(
  providerId: TeamProviderId,
  model: string | null | undefined,
  runtimeProviderStatusById: RuntimeProviderStatusById,
  scope: OpenCodeProviderCatalogScope
): TeamModelRuntimeProviderStatus | null | undefined {
  if (providerId === 'opencode') {
    const sourceId = parseOpenCodeQualifiedModelRef(model)?.sourceId?.trim().toLowerCase();
    if (sourceId && scope.openCodeProviderScopedStatusBySourceId?.has(sourceId)) {
      const scopedStatus = scope.openCodeProviderScopedStatusBySourceId.get(sourceId);
      if (isTeamProviderModelCatalogFresh('opencode', scopedStatus)) {
        return scopedStatus;
      }
    }
  }
  return runtimeProviderStatusById.get(providerId);
}

function shouldPreserveOpenCodeLocalModel(
  providerId: TeamProviderId,
  model: string,
  scope: OpenCodeLocalModelScope
): boolean {
  if (providerId !== 'opencode') {
    return false;
  }
  const sourceId = parseOpenCodeQualifiedModelRef(model)?.sourceId ?? null;
  if (!sourceId) {
    return false;
  }
  return (
    isOpenCodeLocalProviderId(sourceId) ||
    scope.openCodeLocalProviderIds?.has(sourceId) === true ||
    scope.openCodeLocalProviderLookupAuthoritative === false
  );
}

function isKnownOpenCodeLocalModel(
  providerId: TeamProviderId,
  model: string | null | undefined,
  scope: OpenCodeLocalModelScope
): boolean {
  if (providerId !== 'opencode') {
    return false;
  }
  const sourceId = parseOpenCodeQualifiedModelRef(model)?.sourceId ?? null;
  return Boolean(
    sourceId &&
    (isOpenCodeLocalProviderId(sourceId) ||
      scope.openCodeLocalProviderLookupAuthoritative === false ||
      (scope.openCodeLocalProviderLookupAuthoritative === true &&
        scope.openCodeLocalProviderIds?.has(sourceId) === true))
  );
}

export function getSelectedOpenCodeModels(
  selectedProviderId: TeamProviderId,
  selectedModel: string | null | undefined,
  members: readonly MemberDraft[]
): string[] {
  const models = selectedProviderId === 'opencode' ? [selectedModel?.trim() ?? ''] : [];
  for (const member of members) {
    if (
      !member.removedAt &&
      resolveMemberProviderForModelScope({
        memberProviderId: member.providerId,
        selectedProviderId,
      }) === 'opencode'
    ) {
      models.push(member.model?.trim() ?? '');
    }
  }
  return models.filter(Boolean);
}

export function resolveMemberProviderForModelScope(input: {
  memberProviderId?: TeamProviderId;
  selectedProviderId: TeamProviderId;
}): TeamProviderId {
  return normalizeOptionalTeamProviderId(input.memberProviderId) ?? input.selectedProviderId;
}

export function getDialogTeamModelValidationError(
  input: {
    selectedProviderId: TeamProviderId;
    selectedModel?: string | null;
    members: readonly MemberDraft[];
    validateMembers: boolean;
    runtimeProviderStatusById: RuntimeProviderStatusById;
    runtimeProviderLoadingById: RuntimeProviderLoadingById;
  } & OpenCodeLocalModelScope &
    OpenCodeProviderCatalogScope
): string | null {
  const getSelectionError = (
    providerId: TeamProviderId,
    model: string | null | undefined
  ): string | null => {
    const error = getTeamModelSelectionError(
      providerId,
      model ?? undefined,
      getModelScopedProviderStatus(providerId, model, input.runtimeProviderStatusById, input)
    );
    return error && !isKnownOpenCodeLocalModel(providerId, model, input) ? error : null;
  };

  if (!input.runtimeProviderLoadingById.get(input.selectedProviderId)) {
    const leadError = getSelectionError(input.selectedProviderId, input.selectedModel);
    if (leadError) {
      return leadError;
    }
  }
  if (!input.validateMembers) {
    return null;
  }

  for (const member of input.members) {
    if (member.removedAt) {
      continue;
    }
    const providerId = resolveMemberProviderForModelScope({
      memberProviderId: member.providerId,
      selectedProviderId: input.selectedProviderId,
    });
    if (input.runtimeProviderLoadingById.get(providerId)) {
      continue;
    }
    const memberError = getSelectionError(providerId, member.model);
    if (memberError) {
      const memberName = member.name.trim();
      return memberName ? `${memberName}: ${memberError}` : memberError;
    }
  }

  return null;
}

export function resolveProviderScopedMemberModel(
  input: {
    memberProviderId?: TeamProviderId;
    memberModel?: string | null;
    selectedProviderId: TeamProviderId;
    runtimeProviderStatusById: RuntimeProviderStatusById;
  } & OpenCodeLocalModelScope &
    OpenCodeProviderCatalogScope
): { providerId: TeamProviderId; model: string } {
  const providerId = resolveMemberProviderForModelScope(input);
  const rawModel = input.memberModel?.trim() ?? '';
  if (!rawModel) {
    return { providerId, model: '' };
  }

  const normalizedModel = normalizeExplicitTeamModelForUi(providerId, rawModel);
  if (!normalizedModel) {
    return { providerId, model: '' };
  }
  // App-managed local providers are discovered through the local-provider overlay,
  // not solely through the general OpenCode runtime catalog. Preserve their exact
  // route and let deep provider/model readiness prove whether it can launch.
  if (shouldPreserveOpenCodeLocalModel(providerId, normalizedModel, input)) {
    return { providerId, model: normalizedModel };
  }

  const providerStatus =
    getModelScopedProviderStatus(
      providerId,
      normalizedModel,
      input.runtimeProviderStatusById,
      input
    ) ?? null;
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
  return (
    hasTerminalAuthoritativeModelVerification(providerStatus) &&
    isTeamProviderModelCatalogFresh('opencode', providerStatus) &&
    getAvailableTeamProviderModels('opencode', providerStatus).length === 0
  );
}

export function clearInheritedMemberModelsUnavailableForProvider(
  input: {
    members: MemberDraft[];
    selectedProviderId: TeamProviderId;
    runtimeProviderStatusById: RuntimeProviderStatusById;
    deferredProviderIds?: ReadonlySet<TeamProviderId>;
  } & OpenCodeLocalModelScope &
    OpenCodeProviderCatalogScope
): { members: MemberDraft[]; changed: boolean } {
  let changed = false;
  const members = input.members.map((member) => {
    if (member.removedAt || !member.model?.trim()) {
      return member;
    }
    const providerId = resolveMemberProviderForModelScope({
      memberProviderId: member.providerId,
      selectedProviderId: input.selectedProviderId,
    });
    if (input.deferredProviderIds?.has(providerId)) {
      return member;
    }
    if (member.providerId) {
      return member;
    }
    if (shouldPreserveOpenCodeLocalModel(providerId, member.model, input)) {
      return member;
    }
    const providerStatus =
      getModelScopedProviderStatus(
        providerId,
        member.model,
        input.runtimeProviderStatusById,
        input
      ) ?? null;
    if (shouldClearOpenCodeModelToDefault(providerId, providerStatus)) {
      changed = true;
      return {
        ...member,
        model: '',
      };
    }
    if (
      providerId === 'opencode' &&
      (!hasTerminalAuthoritativeModelVerification(providerStatus) ||
        !isTeamProviderModelCatalogFresh('opencode', providerStatus))
    ) {
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
      openCodeLocalProviderIds: input.openCodeLocalProviderIds,
      openCodeLocalProviderLookupAuthoritative: input.openCodeLocalProviderLookupAuthoritative,
      openCodeProviderScopedStatusBySourceId: input.openCodeProviderScopedStatusBySourceId,
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
