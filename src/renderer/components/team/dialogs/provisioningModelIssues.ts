import { getProviderScopedTeamModelLabel } from '@renderer/utils/teamModelCatalog';

import type { ProvisioningProviderCheck } from './ProvisioningProviderStatusList';
import type { TeamProviderId } from '@shared/types';

export interface ProvisioningModelIssue {
  providerId: TeamProviderId;
  modelId: string;
  kind: 'unavailable' | 'check failed';
  reason: string | null;
  detail: string;
}

function extractReason(detail: string, prefix: string): string | null {
  if (!detail.startsWith(prefix)) {
    return null;
  }

  const suffix = detail.slice(prefix.length).trim();
  if (!suffix) {
    return null;
  }
  return suffix.startsWith('- ') ? suffix.slice(2).trim() : suffix;
}

function buildIssueFromFormattedDetail(
  detail: string,
  providerId: TeamProviderId,
  modelId: string,
  label: string
): ProvisioningModelIssue | null {
  const unavailablePrefix = `${label} - unavailable`;
  const unavailableReason = extractReason(detail, unavailablePrefix);
  if (detail.startsWith(unavailablePrefix)) {
    return {
      providerId,
      modelId,
      kind: 'unavailable',
      reason: unavailableReason,
      detail,
    };
  }

  const checkFailedPrefix = `${label} - check failed`;
  const checkFailedReason = extractReason(detail, checkFailedPrefix);
  if (detail.startsWith(checkFailedPrefix)) {
    return {
      providerId,
      modelId,
      kind: 'check failed',
      reason: checkFailedReason,
      detail,
    };
  }

  return null;
}

function buildIssueFromLegacyDetail(
  detail: string,
  providerId: TeamProviderId,
  modelId: string
): ProvisioningModelIssue | null {
  const unavailablePrefix = `Selected model ${modelId} is unavailable.`;
  if (detail.startsWith(unavailablePrefix)) {
    const reason = detail.slice(unavailablePrefix.length).trim() || null;
    return {
      providerId,
      modelId,
      kind: 'unavailable',
      reason,
      detail,
    };
  }

  const checkFailedPrefix = `Selected model ${modelId} could not be verified.`;
  if (detail.startsWith(checkFailedPrefix)) {
    const reason = detail.slice(checkFailedPrefix.length).trim() || null;
    return {
      providerId,
      modelId,
      kind: 'check failed',
      reason,
      detail,
    };
  }

  return null;
}

export function getProvisioningModelIssue(
  checks: ProvisioningProviderCheck[],
  providerId: TeamProviderId,
  modelId: string | null | undefined
): ProvisioningModelIssue | null {
  const trimmedModelId = modelId?.trim() ?? '';
  if (!trimmedModelId) {
    return null;
  }

  const label = getProviderScopedTeamModelLabel(providerId, trimmedModelId) ?? trimmedModelId;
  const providerChecks = checks.filter((check) => check.providerId === providerId);

  for (const check of providerChecks) {
    for (const detail of check.details) {
      const formattedIssue = buildIssueFromFormattedDetail(
        detail,
        providerId,
        trimmedModelId,
        label
      );
      if (formattedIssue) {
        return formattedIssue;
      }

      const legacyIssue = buildIssueFromLegacyDetail(detail, providerId, trimmedModelId);
      if (legacyIssue) {
        return legacyIssue;
      }
    }
  }

  return null;
}
