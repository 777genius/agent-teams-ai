import { DEFAULT_PROVIDER_MODEL_SELECTION } from '@shared/utils/providerModelSelection';
import { isTeamProviderId, normalizeOptionalTeamProviderId } from '@shared/utils/teamProvider';

import { resolveProviderScopedMemberModel } from './memberModelScope';

import type { MemberDraft } from '@renderer/components/team/members/membersEditorTypes';
import type { EffortLevel, TeamProviderId, TeamProvisioningModelCheckRequest } from '@shared/types';

type ScopedModelResolutionContext = Omit<
  Parameters<typeof resolveProviderScopedMemberModel>[0],
  'memberProviderId' | 'memberModel' | 'selectedProviderId'
>;

// Runtimes whose launch resolves "Default" itself, so preflight can check the
// provider default. OpenCode is deliberately absent: its launch authority is
// scoped to an explicit model, and the dialogs materialize its Default into the
// concrete project route before building these checks.
const PROVIDERS_WITH_RUNTIME_DEFAULT_CHECK = new Set<TeamProviderId>(['codex', 'gemini']);

export function buildProviderModelChecksMap(input: {
  leadProviderId: TeamProviderId;
  leadModel: string;
  leadEffort?: EffortLevel;
  members: readonly MemberDraft[];
  scopeContext: ScopedModelResolutionContext;
}): Map<TeamProviderId, TeamProvisioningModelCheckRequest[]> {
  const modelsByProvider = new Map<TeamProviderId, TeamProvisioningModelCheckRequest[]>();

  const addModel = (
    providerId: TeamProviderId,
    model: string | undefined,
    effort?: EffortLevel
  ): void => {
    const trimmed = model?.trim() ?? '';
    if (!trimmed) {
      return;
    }
    const existing = modelsByProvider.get(providerId) ?? [];
    if (!existing.some((entry) => entry.model === trimmed && entry.effort === effort)) {
      modelsByProvider.set(providerId, [
        ...existing,
        { providerId, model: trimmed, ...(effort ? { effort } : {}) },
      ]);
    }
  };

  const addDefaultSelection = (providerId: TeamProviderId, effort?: EffortLevel): void => {
    if (
      PROVIDERS_WITH_RUNTIME_DEFAULT_CHECK.has(providerId) ||
      (providerId === 'anthropic' && input.leadProviderId === 'anthropic')
    ) {
      addModel(providerId, DEFAULT_PROVIDER_MODEL_SELECTION, effort);
    }
  };

  if (input.leadModel.trim()) {
    addModel(input.leadProviderId, input.leadModel, input.leadEffort);
  } else {
    addDefaultSelection(input.leadProviderId, input.leadEffort);
  }

  for (const member of input.members) {
    if (member.removedAt) {
      continue;
    }
    const memberProviderId = normalizeOptionalTeamProviderId(member.providerId);
    const inheritsDefaultRuntime = !memberProviderId || memberProviderId === input.leadProviderId;
    const explicitMemberModel = member.model?.trim() ?? '';
    const memberEffort =
      member.effort ??
      (inheritsDefaultRuntime && !explicitMemberModel ? input.leadEffort : undefined);
    const scopedModel = resolveProviderScopedMemberModel({
      memberProviderId: member.providerId,
      memberModel: member.model,
      selectedProviderId: input.leadProviderId,
      ...input.scopeContext,
    });
    if (scopedModel.model) {
      addModel(scopedModel.providerId, scopedModel.model, memberEffort);
    } else {
      addDefaultSelection(scopedModel.providerId, memberEffort);
    }
  }

  return modelsByProvider;
}

/** The providers a dialog's lead and live members run on, lead first. */
export function collectDialogMemberProviderIds(
  multimodelEnabled: boolean,
  selectedProviderId: TeamProviderId,
  members: readonly MemberDraft[]
): TeamProviderId[] {
  if (!multimodelEnabled) return ['anthropic'];
  return Array.from(
    new Set([
      selectedProviderId,
      ...members.flatMap((member) =>
        !member.removedAt && isTeamProviderId(member.providerId) ? [member.providerId] : []
      ),
    ])
  );
}
