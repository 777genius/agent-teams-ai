import { useCallback } from 'react';

import { useAppTranslation } from '@features/localization/renderer';
import { api } from '@renderer/api';
import { confirm } from '@renderer/components/common/ConfirmDialog';
import {
  captureContextScopedRequestEpoch,
  isContextScopedRequestEpochCurrent,
} from '@renderer/store/utils/contextScopedRequestEpoch';

import { getProviderDisconnectAction } from './providerConnectionUi';

import type { CliProviderId, CliProviderStatus } from '@shared/types';

export interface NativeClaudeAuthenticationAction {
  readonly action: 'login' | 'logout';
  readonly projectPath: string | null;
  readonly connectionContextToken?: string;
  readonly error?: string;
}

/** Capture the original native account before confirmation or rendering can change the foreground selection. */
export function useProviderAuthenticationActions({
  providers,
  projectPath,
  openNative,
  openLegacy,
}: {
  readonly providers: readonly CliProviderStatus[] | undefined;
  readonly projectPath: string | null;
  readonly openNative: (
    providerId: CliProviderId,
    action: NativeClaudeAuthenticationAction
  ) => void;
  readonly openLegacy: (request: { providerId: CliProviderId; action: 'login' | 'logout' }) => void;
}) {
  const { t } = useAppTranslation('settings');
  const request = useCallback(
    async (providerId: CliProviderId, action: 'login' | 'logout') => {
      const provider = providers?.find((entry) => entry.providerId === providerId);
      const epoch = captureContextScopedRequestEpoch();
      const native = provider?.nativeAuthManagement === 'claude';
      // Invoking IPC starts Main's original owner capture synchronously, before confirmation awaits.
      const originalForm = native
        ? api.runtimeProviderManagement
            .loadSetupForm({
              runtimeId: 'claude',
              providerId: 'anthropic',
              projectPath,
            })
            .then((response) => {
              const token = response.setupForm?.connectionContextToken;
              if (response.error || !token)
                throw new Error(
                  response.error?.message ??
                    'Unable to capture the original Claude account. Refresh its status.'
                );
              return { connectionContextToken: token };
            })
            .catch((error: unknown) => ({
              error:
                error instanceof Error
                  ? error.message
                  : 'Unable to capture the original Claude account. Refresh its status.',
            }))
        : null;
      if (action === 'logout') {
        const disconnect = provider ? getProviderDisconnectAction(provider, t) : null;
        if (
          !disconnect ||
          !(await confirm({
            title: disconnect.title,
            message: disconnect.message,
            confirmLabel: disconnect.confirmLabel,
            cancelLabel: t('providerRuntime.actions.cancel'),
            variant: 'danger',
          }))
        )
          return;
      }
      if (originalForm) {
        const captured = await originalForm;
        if (isContextScopedRequestEpochCurrent(epoch))
          openNative(providerId, { action, projectPath, ...captured });
      } else if (isContextScopedRequestEpochCurrent(epoch)) openLegacy({ providerId, action });
    },
    [openLegacy, openNative, projectPath, providers, t]
  );
  return request;
}
