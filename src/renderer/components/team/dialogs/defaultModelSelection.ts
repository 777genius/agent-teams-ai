import { isHostTeamSelectionKey } from '@features/agent-backend/contracts';
import { DEFAULT_PROVIDER_MODEL_SELECTION } from '@shared/utils/providerModelSelection';
import { buildEffectiveTeamMemberSpec } from '@shared/utils/teamMemberRuntimeSelection';
import { isTeamProviderId, normalizeOptionalTeamProviderId } from '@shared/utils/teamProvider';

import { resolveProviderScopedMemberModel } from './memberModelScope';

import type { MemberDraft } from '@renderer/components/team/members/membersEditorTypes';
import type {
  EffortLevel,
  TeamProviderId,
  TeamProvisioningModelCheckRequest,
  TeamProvisioningModelTarget,
} from '@shared/types';

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
  teamName?: string;
  syncModelsWithLead?: boolean;
  leadProviderId: TeamProviderId;
  leadModel: string;
  leadEffort?: EffortLevel;
  members: readonly MemberDraft[];
  scopeContext: ScopedModelResolutionContext;
}): Map<TeamProviderId, TeamProvisioningModelCheckRequest[]> {
  const modelsByProvider = new Map<TeamProviderId, TeamProvisioningModelCheckRequest[]>();
  const targeted = isHostTeamSelectionKey(input.teamName);

  const addModel = (
    providerId: TeamProviderId,
    model: string | undefined,
    effort: EffortLevel | undefined,
    target: TeamProvisioningModelTarget
  ): void => {
    const trimmed = model?.trim() ?? '';
    if (!trimmed) {
      return;
    }
    const existing = modelsByProvider.get(providerId) ?? [];
    const same = existing.find((entry) => entry.model === trimmed && entry.effort === effort);
    if (same) {
      if (targeted) (same.targets ??= []).push(target);
    } else {
      modelsByProvider.set(providerId, [
        ...existing,
        {
          providerId,
          model: trimmed,
          ...(effort ? { effort } : {}),
          ...(targeted && target ? { targets: [target] } : {}),
        },
      ]);
    }
  };

  const addDefaultSelection = (
    providerId: TeamProviderId,
    effort: EffortLevel | undefined,
    target: TeamProvisioningModelTarget
  ): void => {
    if (
      targeted ||
      PROVIDERS_WITH_RUNTIME_DEFAULT_CHECK.has(providerId) ||
      (providerId === 'anthropic' && input.leadProviderId === 'anthropic')
    ) {
      addModel(providerId, DEFAULT_PROVIDER_MODEL_SELECTION, effort, target);
    }
  };

  if (input.leadModel.trim()) {
    addModel(input.leadProviderId, input.leadModel, input.leadEffort, { kind: 'lead' });
  } else {
    addDefaultSelection(input.leadProviderId, input.leadEffort, { kind: 'lead' });
  }

  for (const member of input.members) {
    if (member.removedAt) {
      continue;
    }
    const target: TeamProvisioningModelTarget = {
      kind: 'member',
      name: member.name.trim(),
      ...(member.originalName ? { originalName: member.originalName.trim() } : {}),
    };
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
    if (targeted) {
      const effective = buildEffectiveTeamMemberSpec(
        {
          name: member.name,
          providerId: member.providerId,
          model: scopedModel.model || member.model,
          effort: member.effort,
        },
        {
          providerId: input.leadProviderId,
          model: input.leadModel,
          effort: input.leadEffort,
          syncModelsWithLead: input.syncModelsWithLead,
        }
      );
      addModel(
        scopedModel.providerId,
        effective.model || DEFAULT_PROVIDER_MODEL_SELECTION,
        effective.effort,
        target
      );
      continue;
    }
    if (scopedModel.model) {
      addModel(scopedModel.providerId, scopedModel.model, memberEffort, target);
    } else {
      addDefaultSelection(scopedModel.providerId, memberEffort, target);
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
