import { compareTeamModelRecommendations } from '@renderer/utils/teamModelRecommendations';

import { compareModelFreshness } from './teamModelFreshness';

import type { TeamRuntimeModelOption } from '@renderer/utils/teamModelAvailability';
import type { CliProviderStatus } from '@shared/types';

type ProviderModelCatalogItem = NonNullable<CliProviderStatus['modelCatalog']>['models'][number];

interface OpenCodeModelOptionCandidate {
  option: TeamRuntimeModelOption;
  index: number;
  catalogModel: ProviderModelCatalogItem | null;
  sourceInfo: { id: string } | null;
  routeTag: string | null;
  searchText: string;
  isRecommended: boolean;
  isFree: boolean;
  isNew: boolean;
}

/** The OpenCode picker's visible options for the current query and filters. */
export function selectVisibleOpenCodeModelOptions<T extends OpenCodeModelOptionCandidate>(input: {
  metadata: readonly T[];
  modelQuery: string;
  recommendedOnly: boolean;
  freeOnly: boolean;
  newOnly: boolean;
  selectedRouteTags: ReadonlySet<string>;
  selectedSourceIds: ReadonlySet<string>;
  value: string;
  defaultModel: string | null;
  defaultUnavailable: boolean;
}): T[] {
  const normalizedModelQuery = input.modelQuery.trim().toLowerCase();
  const matchesModelQuery = (metadata: T): boolean =>
    !normalizedModelQuery || metadata.searchText.includes(normalizedModelQuery);

  const concreteOptions = input.metadata
    .filter((metadata) => metadata.option.value.trim().length > 0)
    .filter((metadata) => !input.recommendedOnly || metadata.isRecommended)
    .filter((metadata) => !input.freeOnly || metadata.isFree)
    .filter((metadata) => !input.newOnly || metadata.isNew)
    .filter(
      (metadata) =>
        input.selectedRouteTags.size === 0 ||
        Boolean(metadata.routeTag && input.selectedRouteTags.has(metadata.routeTag))
    )
    .filter(
      (metadata) =>
        input.selectedSourceIds.size === 0 ||
        Boolean(metadata.sourceInfo && input.selectedSourceIds.has(metadata.sourceInfo.id))
    )
    .filter(matchesModelQuery)
    .sort((left, right) => {
      const recommendationOrder = compareTeamModelRecommendations(
        'opencode',
        left.option.value,
        right.option.value
      );
      if (recommendationOrder !== 0) {
        return recommendationOrder;
      }
      if (left.isFree !== right.isFree) {
        return left.isFree ? -1 : 1;
      }
      const freshnessOrder = compareModelFreshness(left, right);
      if (freshnessOrder !== 0) {
        return freshnessOrder;
      }
      return left.index - right.index;
    });

  // Under a source or route filter, still offer Default next to the route it
  // launches (e.g. the Zen tab), so users see what Default means. It also
  // stays when it is the current selection or carries its unusable reason.
  const keepsDefaultInView =
    !input.value.trim() ||
    input.defaultUnavailable ||
    concreteOptions.some((metadata) => metadata.option.value === input.defaultModel);
  const filtered =
    input.recommendedOnly ||
    input.freeOnly ||
    input.newOnly ||
    input.selectedRouteTags.size > 0 ||
    input.selectedSourceIds.size > 0;
  if (filtered && !keepsDefaultInView) {
    return concreteOptions;
  }

  return [
    ...input.metadata
      .filter((metadata) => metadata.option.value.trim().length === 0)
      .filter(matchesModelQuery),
    ...concreteOptions,
  ];
}
