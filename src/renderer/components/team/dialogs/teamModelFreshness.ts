import {
  compareModelReleaseFreshness,
  isRecentlyReleasedModel,
} from '@renderer/utils/modelReleaseFreshness';
import { compareTeamModelVersionsDescending } from '@renderer/utils/teamModelCatalog';

import type { TeamRuntimeModelOption } from '@renderer/utils/teamModelAvailability';
import type { CliProviderStatus } from '@shared/types';

type ProviderModelCatalogItem = NonNullable<CliProviderStatus['modelCatalog']>['models'][number];

export { isRecentlyReleasedModel };

export function compareModelFreshness(
  left: { option: TeamRuntimeModelOption; catalogModel: ProviderModelCatalogItem | null },
  right: { option: TeamRuntimeModelOption; catalogModel: ProviderModelCatalogItem | null }
): number {
  return (
    compareModelReleaseFreshness(left.catalogModel, right.catalogModel) ||
    compareTeamModelVersionsDescending(left.option.value, right.option.value)
  );
}
