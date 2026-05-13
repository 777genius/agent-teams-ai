import {
  getOpenCodeTeamModelRecommendation,
  getOpenCodeTeamModelRecommendationSortRank,
} from '@renderer/utils/openCodeModelRecommendations';
import { isSupportedAnthropicTeamModel } from '@renderer/utils/teamModelCatalog';

import type {
  OpenCodeTeamModelRecommendation,
  OpenCodeTeamModelRecommendationLevel,
} from '@renderer/utils/openCodeModelRecommendations';
import type { TeamProviderId } from '@shared/types';

export type TeamModelRecommendationLevel = OpenCodeTeamModelRecommendationLevel;
export type TeamModelRecommendation = OpenCodeTeamModelRecommendation;

const CODEX_TEAM_RECOMMENDED_MODELS = new Set<string>([
  'gpt-5.5',
  'gpt-5.4',
  'gpt-5.4-mini',
  'gpt-5.3-codex',
  'gpt-5.2',
]);

const CODEX_RECOMMENDED_REASON =
  'This Codex model passed real Agent Teams launch and task-flow stress testing and is selected for stable team-agent behavior.';

const ANTHROPIC_RECOMMENDED_REASON =
  'This Claude model passed real Agent Teams launch, restart, and teammate-workflow stress testing.';

function normalizeTeamModelId(modelId: string | null | undefined): string {
  return modelId?.trim().toLowerCase() ?? '';
}

function getRecommendedRecommendation(reason: string): TeamModelRecommendation {
  return {
    level: 'recommended',
    label: 'Recommended',
    reason,
  };
}

export function getTeamModelRecommendation(
  providerId: TeamProviderId,
  modelId: string | null | undefined
): TeamModelRecommendation | null {
  const normalizedModelId = normalizeTeamModelId(modelId);
  if (!normalizedModelId) {
    return null;
  }

  if (providerId === 'opencode') {
    return getOpenCodeTeamModelRecommendation(normalizedModelId);
  }

  if (providerId === 'codex' && CODEX_TEAM_RECOMMENDED_MODELS.has(normalizedModelId)) {
    return getRecommendedRecommendation(CODEX_RECOMMENDED_REASON);
  }

  if (providerId === 'anthropic' && isSupportedAnthropicTeamModel(normalizedModelId)) {
    return getRecommendedRecommendation(ANTHROPIC_RECOMMENDED_REASON);
  }

  return null;
}

export function isTeamModelRecommended(
  providerId: TeamProviderId,
  modelId: string | null | undefined
): boolean {
  const recommendation = getTeamModelRecommendation(providerId, modelId);
  return (
    recommendation?.level === 'recommended' || recommendation?.level === 'recommended-with-limits'
  );
}

function getTeamModelRecommendationSortRank(
  providerId: TeamProviderId,
  modelId: string | null | undefined
): number {
  if (providerId === 'opencode') {
    return getOpenCodeTeamModelRecommendationSortRank(modelId);
  }

  const recommendation = getTeamModelRecommendation(providerId, modelId);
  if (recommendation?.level === 'recommended') {
    return 0;
  }
  return 4;
}

export function compareTeamModelRecommendations(
  providerId: TeamProviderId,
  leftModelId: string | null | undefined,
  rightModelId: string | null | undefined
): number {
  const leftRank = getTeamModelRecommendationSortRank(providerId, leftModelId);
  const rightRank = getTeamModelRecommendationSortRank(providerId, rightModelId);
  if (leftRank !== rightRank) {
    return leftRank - rightRank;
  }
  return 0;
}
