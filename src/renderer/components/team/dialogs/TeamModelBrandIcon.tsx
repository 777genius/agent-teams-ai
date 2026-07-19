import React from 'react';

import { ProviderBrandIcon } from '@features/runtime-provider-management/renderer';
import { ProviderBrandLogo } from '@renderer/components/common/ProviderBrandLogo';
import { getTeamModelSourceBadgeLabel } from '@renderer/utils/teamModelCatalog';
import { parseOpenCodeQualifiedModelRef } from '@shared/utils/opencodeModelRef';

import type { TeamProviderId } from '@shared/types';

export const TeamModelBrandIcon = ({
  providerId,
  model,
}: {
  providerId: TeamProviderId;
  model: string;
}): React.JSX.Element => {
  const parsedSource =
    providerId === 'opencode' && model.trim() ? parseOpenCodeQualifiedModelRef(model.trim()) : null;

  if (parsedSource) {
    return (
      <ProviderBrandIcon
        provider={{
          providerId: parsedSource.sourceId,
          displayName: getTeamModelSourceBadgeLabel('opencode', model) ?? parsedSource.sourceId,
        }}
        size="small"
      />
    );
  }

  return <ProviderBrandLogo providerId={providerId} className="size-3.5 shrink-0" />;
};
