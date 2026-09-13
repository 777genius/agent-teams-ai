import { useCallback } from 'react';

import { useAppTranslation } from '@features/localization/renderer';
import { api } from '@renderer/api';

import type { Dispatch, RefObject, SetStateAction } from 'react';

export function useModelTestStop(
  runtimeId: string,
  activeModelTestRequestGroupsRef: RefObject<Map<string, number>>,
  pendingModelStopsRef: RefObject<Map<string, Promise<boolean>>>,
  setTestingModelIds: Dispatch<SetStateAction<readonly string[]>>,
  setModelTestStartedAt: Dispatch<SetStateAction<Readonly<Record<string, number>>>>,
  setError: Dispatch<SetStateAction<string | null>>,
  withUiTimeout: <T>(promise: Promise<T>, message: string, timeoutMs: number) => Promise<T>
): (providerId: string, modelId: string) => Promise<boolean> {
  const { t } = useAppTranslation('settings');
  return useCallback(
    (providerId: string, modelId: string): Promise<boolean> => {
      const requestGroupId = `runtime-provider-management:${runtimeId}:model-test:${providerId}:${modelId}`;
      const token = activeModelTestRequestGroupsRef.current.get(requestGroupId);
      if (token === undefined) return Promise.resolve(false);
      const transportId = `${requestGroupId}:${token}`;
      const pending = pendingModelStopsRef.current.get(transportId);
      if (pending) return pending;
      const operation = (async (): Promise<boolean> => {
        try {
          const cancel = api.runtimeProviderManagement.cancelModelTest;
          if (!cancel) throw new Error(t('runtimeProvider.models.testCancelUnsupported'));
          const response = await withUiTimeout(
            cancel({ requestGroupId: transportId }),
            t('runtimeProvider.models.testCancelFailed'),
            10_000
          );
          if (!response.ok)
            throw new Error(response.error || t('runtimeProvider.models.testCancelFailed'));
          if (activeModelTestRequestGroupsRef.current.get(requestGroupId) !== token) return false;
          activeModelTestRequestGroupsRef.current.delete(requestGroupId);
          setTestingModelIds((current) => current.filter((id) => id !== modelId));
          setModelTestStartedAt((current) => withoutModelTestStart(current, modelId));
          return true;
        } catch (error) {
          if (activeModelTestRequestGroupsRef.current.get(requestGroupId) !== token) return false;
          setError(
            error instanceof Error ? error.message : t('runtimeProvider.models.testCancelFailed')
          );
          return false;
        }
      })();
      pendingModelStopsRef.current.set(transportId, operation);
      void operation.finally(() => pendingModelStopsRef.current.delete(transportId));
      return operation;
    },
    [
      withUiTimeout,
      runtimeId,
      t,
      activeModelTestRequestGroupsRef,
      pendingModelStopsRef,
      setTestingModelIds,
      setModelTestStartedAt,
      setError,
    ]
  );
}

export function withoutModelTestStart(
  current: Readonly<Record<string, number>>,
  modelId: string
): Readonly<Record<string, number>> {
  const next = { ...current };
  delete next[modelId];
  return next;
}
