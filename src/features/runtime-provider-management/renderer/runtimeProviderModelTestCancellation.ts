import { useCallback } from 'react';

import { api } from '@renderer/api';

export function cancelRuntimeProviderModelTestBestEffort(requestGroupId: string): void {
  const cancelModelTest = api.runtimeProviderManagement.cancelModelTest;
  if (!cancelModelTest) return;
  void cancelModelTest({ requestGroupId }).catch(() => undefined);
}

export function useRuntimeProviderModelTestCancellation(requestGroupId: string): () => void {
  return useCallback(
    () => cancelRuntimeProviderModelTestBestEffort(requestGroupId),
    [requestGroupId]
  );
}
