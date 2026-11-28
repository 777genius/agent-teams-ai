import { useAppTranslation } from '@features/localization/renderer';
import { CapturedClaudeAuthenticationPanel } from '@features/runtime-provider-management/renderer';
import { Button } from '@renderer/components/ui/button';
import { Link2, Loader2 } from 'lucide-react';

import { getProviderConnectLabel } from './providerConnectionUi';

import type { NativeClaudeAuthenticationAction } from './useProviderAuthenticationActions';
import type { CliProviderId, CliProviderStatus } from '@shared/types';

export const ProviderConnectionHeader = ({
  provider,
  description,
  progressMessage,
  busy,
  canRequestLogin,
  onRequestLogin,
  open,
  nativeAuthAction,
  onProviderChanged,
}: {
  readonly open: boolean;
  readonly nativeAuthAction?: NativeClaudeAuthenticationAction | null;
  readonly onProviderChanged?: () => Promise<boolean | void> | boolean | void;
  readonly provider: CliProviderStatus;
  readonly description: string;
  readonly progressMessage: string | null;
  readonly busy: boolean;
  readonly canRequestLogin: boolean;
  readonly onRequestLogin?: (providerId: CliProviderId) => void;
}) => {
  const { t } = useAppTranslation('settings');
  return (
    <>
      {provider.nativeAuthManagement === 'claude' && nativeAuthAction ? (
        <CapturedClaudeAuthenticationPanel
          key={nativeAuthAction.connectionContextToken ?? nativeAuthAction.error}
          open={open}
          projectPath={nativeAuthAction.projectPath}
          action={nativeAuthAction.action}
          connectionContextToken={nativeAuthAction.connectionContextToken}
          captureError={nativeAuthAction.error}
          onChanged={onProviderChanged}
        />
      ) : null}
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-sm font-medium" style={{ color: 'var(--color-text)' }}>
            {t('providerRuntime.connection.title')}
          </div>
          <div className="text-xs" style={{ color: 'var(--color-text-muted)' }}>
            {description}
          </div>
          {progressMessage ? (
            <div
              className="mt-2 inline-flex items-center gap-1.5 text-[11px]"
              style={{ color: 'var(--color-text-secondary)' }}
            >
              <Loader2 className="size-3 animate-spin" />
              <span>{progressMessage}</span>
            </div>
          ) : null}
        </div>
        {canRequestLogin ? (
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() => onRequestLogin?.(provider.providerId)}
          >
            <Link2 className="mr-1 size-3.5" />
            {provider.authenticated &&
            (provider.authMethod === 'oauth_token' || provider.authMethod === 'claude.ai')
              ? t('providerRuntime.actions.reconnectAnthropic')
              : getProviderConnectLabel(provider, t)}
          </Button>
        ) : null}
      </div>
    </>
  );
};
