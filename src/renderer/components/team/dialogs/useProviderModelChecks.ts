import { useMemo } from 'react';

import { buildProviderModelChecksMap } from './defaultModelSelection';

/** Keep the existing dialog's grouped choices stable while retaining member destinations. */
export function useProviderModelChecks(input: Parameters<typeof buildProviderModelChecksMap>[0]) {
  const { teamName, syncModelsWithLead, leadProviderId, leadModel, leadEffort, members } = input;
  const {
    runtimeProviderStatusById,
    openCodeLocalProviderIds,
    openCodeLocalProviderLookupAuthoritative,
    openCodeProviderScopedStatusBySourceId,
  } = input.scopeContext;
  return useMemo(
    () =>
      buildProviderModelChecksMap({
        teamName,
        syncModelsWithLead,
        leadProviderId,
        leadModel,
        leadEffort,
        members,
        scopeContext: {
          runtimeProviderStatusById,
          openCodeLocalProviderIds,
          openCodeLocalProviderLookupAuthoritative,
          openCodeProviderScopedStatusBySourceId,
        },
      }),
    [
      teamName,
      syncModelsWithLead,
      leadProviderId,
      leadModel,
      leadEffort,
      members,
      runtimeProviderStatusById,
      openCodeLocalProviderIds,
      openCodeLocalProviderLookupAuthoritative,
      openCodeProviderScopedStatusBySourceId,
    ]
  );
}
