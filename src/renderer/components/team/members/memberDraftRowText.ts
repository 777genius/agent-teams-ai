import {
  getProviderScopedTeamModelLabel,
  getTeamProviderLabel,
} from '@renderer/components/team/dialogs/TeamModelSelector';

import type { TeamMemberMcpMode, TeamProviderId } from '@shared/types';

type ModelReasonByValue = Partial<Record<string, string | null | undefined>>;
export type ModelReasonByProvider = Partial<Record<TeamProviderId, ModelReasonByValue>>;

export const MEMBER_MCP_SCOPE_LABEL_KEYS = {
  user: 'memberDraft.mcp.scopes.user',
  project: 'memberDraft.mcp.scopes.project',
  local: 'memberDraft.mcp.scopes.local',
} as const;

/** The issue (blocking) and advisory text shown for a member's selected model. */
export function resolveMemberModelReasonTexts(input: {
  providerId: TeamProviderId;
  modelKey: string;
  modelIssueText?: string | null;
  issueByProvider?: ModelReasonByProvider;
  unavailableByProvider?: ModelReasonByProvider;
  advisoryByProvider?: ModelReasonByProvider;
}): { issueText: string | null; advisoryText: string | null } {
  const lookup = (byProvider?: ModelReasonByProvider): string | null =>
    (input.modelKey && byProvider?.[input.providerId]?.[input.modelKey]) || null;
  const issueText =
    input.modelIssueText ??
    lookup(input.unavailableByProvider) ??
    lookup(input.issueByProvider) ??
    null;
  return { issueText, advisoryText: issueText ? null : lookup(input.advisoryByProvider) };
}

export function formatMemberMcpButtonLabel(
  mode: TeamMemberMcpMode,
  serverCount: number,
  labels: { scopes: string; inherit: string }
): string {
  if (mode === 'appOnly') return 'Agent Teams MCP';
  if (mode === 'strictAllowlist') return `MCP ${serverCount || 'strict'}`;
  return mode === 'inheritScopes' ? labels.scopes : labels.inherit;
}

export function resolveMemberModelButtonLabels({
  effectiveProviderId,
  effectiveModel,
  defaultModelLabel,
  inheritsLeadModel,
  unresolved,
  t,
}: {
  effectiveProviderId: TeamProviderId;
  effectiveModel?: string;
  defaultModelLabel?: { label: string; modelLabel: string } | null;
  inheritsLeadModel: boolean;
  unresolved: boolean;
  t: ReturnType<typeof import('@features/localization/renderer').useAppTranslation>['t'];
}) {
  const modelButtonLabelBase = effectiveModel?.trim()
    ? getProviderScopedTeamModelLabel(effectiveProviderId, effectiveModel.trim())
    : defaultModelLabel
      ? t('modelSelector.defaultWithResolved', { model: defaultModelLabel.label })
      : t('memberDraft.model.default');
  const modelButtonLabel = unresolved
    ? 'Provider not selected'
    : inheritsLeadModel
      ? t('memberDraft.model.leadSuffix', { label: modelButtonLabelBase })
      : modelButtonLabelBase;
  const modelButtonText =
    !unresolved && defaultModelLabel
      ? t('modelSelector.defaultCompact', { model: defaultModelLabel.modelLabel })
      : modelButtonLabel;
  const modelButtonAriaLabel = t('memberDraft.model.ariaLabel', {
    provider: unresolved ? 'Not selected' : getTeamProviderLabel(effectiveProviderId),
    model: modelButtonLabel,
  });
  return { modelButtonLabel, modelButtonText, modelButtonAriaLabel };
}
