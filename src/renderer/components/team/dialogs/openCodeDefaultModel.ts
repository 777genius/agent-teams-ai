import { getRuntimeAwareProviderScopedTeamModelLabel } from '@renderer/utils/teamModelCatalog';
import {
  getOpenCodeQualifiedModelSourceLabel,
  parseOpenCodeQualifiedModelRef,
} from '@shared/utils/opencodeModelRef';
import { normalizeOptionalTeamProviderId } from '@shared/utils/teamProvider';

import type { MemberDraft } from '@renderer/components/team/members/membersEditorTypes';
import type { CliProviderStatus, TeamProviderId } from '@shared/types';

export type OpenCodeProjectDefaultModel =
  | { state: 'unknown' }
  | { state: 'available'; model: string }
  | { state: 'unavailable' };

const BLOCKED_DEFAULT_ACCESS_KINDS = new Set(['not_authenticated', 'execution_failed']);

/**
 * The OpenCode "Default" route for a project, read from the project-scoped
 * catalog (the same one the dialog preflight and launch guard work from).
 * OpenCode picks its default from config, last use or internal priority, so
 * the dialogs never send "Default" itself: they send this concrete route.
 */
export function resolveOpenCodeProjectDefaultModel(
  status: CliProviderStatus | null | undefined
): OpenCodeProjectDefaultModel {
  const catalog = status?.modelCatalog;
  // A stale catalog still names the route; a refresh only replaces it, and
  // preflight independently requires fresh catalog authority before launch.
  if (
    !catalog ||
    catalog.providerId !== 'opencode' ||
    (catalog.status !== 'ready' && catalog.status !== 'stale')
  ) {
    return { state: 'unknown' };
  }
  const model = catalog.defaultLaunchModel?.trim() || catalog.defaultModelId?.trim() || '';
  if (!parseOpenCodeQualifiedModelRef(model)) {
    return { state: 'unavailable' };
  }
  const entry = catalog.models.find((item) => item.launchModel === model || item.id === model);
  // Catalog metadata can be partial; the runtime model list still counts as
  // knowing the route. Only an explicit signal marks the default unusable.
  const listedByRuntime = status?.models?.includes(model) === true;
  const route = entry?.metadata?.opencode;
  const availability = status?.modelAvailability?.find((item) => item.modelId === model);
  if (
    (!entry && !listedByRuntime) ||
    entry?.hidden ||
    availability?.status === 'unavailable' ||
    route?.proofState === 'failed' ||
    (route?.accessKind != null && BLOCKED_DEFAULT_ACCESS_KINDS.has(route.accessKind))
  ) {
    return { state: 'unavailable' };
  }
  return { state: 'available', model: entry?.launchModel || model };
}

/** "big-pickle (OpenCode Zen)": the route Default launches, with its source. */
export function formatOpenCodeDefaultRouteLabel(
  model: string,
  status?: CliProviderStatus | null
): string {
  if (model === 'openrouter/openrouter/free') return 'Free Models Router';
  const runtimeLabel = getRuntimeAwareProviderScopedTeamModelLabel('opencode', model, status);
  const modelLabel =
    runtimeLabel && runtimeLabel !== model
      ? runtimeLabel
      : (parseOpenCodeQualifiedModelRef(model)?.modelId ?? model);
  const sourceLabel = getOpenCodeQualifiedModelSourceLabel(model);
  return sourceLabel ? `${modelLabel} (${sourceLabel})` : modelLabel;
}

interface OpenCodeDefaultSelectionInput {
  selectedProviderId: TeamProviderId;
  selectedModel: string | null | undefined;
  members: readonly MemberDraft[];
  syncModelsWithLead: boolean;
  projectDefault: OpenCodeProjectDefaultModel;
}

/**
 * Replaces every OpenCode selection that would otherwise reach launch as
 * "Default" with the project's concrete default route. Inheritance mirrors
 * buildEffectiveTeamMemberSpec in main: a synced teammate on the lead's
 * provider keeps an empty model and inherits the (now explicit) lead model,
 * so saved team settings still follow the lead.
 */
export function materializeOpenCodeDefaultSelections(input: OpenCodeDefaultSelectionInput): {
  selectedModel: string;
  members: MemberDraft[];
  unresolvedMemberNames: string[];
  leadUnresolved: boolean;
} {
  const defaultModel =
    input.projectDefault.state === 'available' ? input.projectDefault.model : null;
  const rawLeadModel = input.selectedModel?.trim() ?? '';
  const leadIsOpenCodeDefault = input.selectedProviderId === 'opencode' && !rawLeadModel;
  const selectedModel = leadIsOpenCodeDefault && defaultModel ? defaultModel : rawLeadModel;
  const unresolvedMemberNames: string[] = [];

  const members = input.members.map((member) => {
    if (member.removedAt || member.model?.trim()) {
      return member;
    }
    const memberProviderId = normalizeOptionalTeamProviderId(member.providerId);
    if ((memberProviderId ?? input.selectedProviderId) !== 'opencode') {
      return member;
    }
    const usesLeadProvider = !memberProviderId || memberProviderId === input.selectedProviderId;
    if (input.syncModelsWithLead && usesLeadProvider && selectedModel) {
      return member;
    }
    if (!defaultModel) {
      unresolvedMemberNames.push(member.name.trim());
      return member;
    }
    return { ...member, model: defaultModel };
  });

  return {
    selectedModel,
    members,
    unresolvedMemberNames,
    leadUnresolved: leadIsOpenCodeDefault && !defaultModel,
  };
}
