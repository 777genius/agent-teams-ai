import { useRef } from 'react';

import { useStore } from '@renderer/store';
import { isDefaultProviderModelSelection } from '@shared/utils/providerModelSelection';

import { buildProviderPrepareAttemptRuntimeSignature } from './providerPrepareAttemptIdentity';
import { computeEffectiveTeamModel } from './teamModelSummary';

import type { CliProviderStatus, TeamProviderId } from '@shared/types';

/** Keep an explicit product choice stable while passive discovery temporarily hides its catalog. */
export function useCreateTeamLaunchModel(input: {
  open: boolean;
  selectedModel: string;
  limitContext: boolean;
  providerId: TeamProviderId;
  providerStatus: CliProviderStatus | null | undefined;
}): string | undefined {
  const sourceContext = useStore((state) =>
    JSON.stringify([
      state.activeContextId,
      state.targetContextId,
      state.isContextSwitching,
      state.connectionMode,
      state.connectedHost,
      state.appConfig?.general?.claudeRootPath,
    ])
  );
  const identity = JSON.stringify([
    sourceContext,
    input.providerId,
    input.selectedModel,
    input.limitContext,
    input.providerStatus?.resolvedBackendId,
    buildProviderPrepareAttemptRuntimeSignature(input.providerStatus),
  ]);
  const previous = useRef<{ identity: string; model: string | undefined } | null>(null);
  const model = computeEffectiveTeamModel(
    input.selectedModel,
    input.limitContext,
    input.providerId,
    input.providerStatus
  );
  if (
    !input.open ||
    !input.selectedModel.trim() ||
    isDefaultProviderModelSelection(input.selectedModel)
  ) {
    previous.current = null;
    return model;
  }
  if (
    input.providerStatus?.modelCatalogRefreshState === 'loading' &&
    previous.current?.identity === identity
  )
    return previous.current.model;
  previous.current = { identity, model };
  return model;
}
