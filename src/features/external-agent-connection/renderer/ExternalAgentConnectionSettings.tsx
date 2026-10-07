import { useAppTranslation } from '@features/localization/renderer';
import { Button } from '@renderer/components/ui/button';
import { Label } from '@renderer/components/ui/label';
import { Switch } from '@renderer/components/ui/switch';

import { useConnectionInfo } from './useConnectionInfo';

import type { ExternalAgentConnectionApi } from '../contracts';

interface Props {
  api: ExternalAgentConnectionApi;
  local: boolean;
  cdpEnabled: boolean;
  saving: boolean;
  onCdpEnabledChange(enabled: boolean): void;
}

export function ExternalAgentConnectionSettings({
  api,
  local,
  cdpEnabled,
  saving,
  onCdpEnabledChange,
}: Readonly<Props>): React.JSX.Element {
  const { t } = useAppTranslation('settings');
  const { info, error, retrying, retry } = useConnectionInfo(api, local);
  const mcpReady = info?.mcp.status === 'ready' && info.control.status === 'ready';
  const cdpOpen =
    Boolean(info?.cdp.httpOrigin) &&
    (info?.cdp.status === 'ready' || info?.cdp.status === 'restart-required');
  // The snapshot describes actual access. A saved preference cannot revoke native CDP.
  const restartRequired =
    info?.cdp.status === 'restart-required' ||
    (cdpEnabled && info?.cdp.status === 'disabled') ||
    (!cdpEnabled && cdpOpen);
  const endpoints = [
    ['MCP (Streamable HTTP)', mcpReady ? info.mcp.url : null],
    ['CDP HTTP', cdpOpen ? info?.cdp.httpOrigin : null],
    ['Browser WebSocket', cdpOpen ? info?.cdp.browserWsUrl : null],
    ['Renderer target', cdpOpen ? info?.cdp.rendererTargetId : null],
    ['Renderer WebSocket', cdpOpen ? info?.cdp.rendererWsUrl : null],
  ];

  return (
    <section className="mt-6 space-y-3" aria-label={t('general.externalAgentConnection.title')}>
      <h3 className="text-sm font-semibold text-[var(--color-text)]">
        {t('general.externalAgentConnection.title')}
      </h3>
      <p className="text-xs text-[var(--color-text-muted)]">
        {t('general.externalAgentConnection.description')}
      </p>
      {!local ? (
        <p className="text-xs text-[var(--warning-text)]">
          {t('general.externalAgentConnection.localOnly')}
        </p>
      ) : (
        <>
          <div className="flex items-center justify-between gap-3">
            <p className="text-xs text-[var(--color-text-secondary)]" aria-live="polite">
              {t('general.externalAgentConnection.status', {
                mcp: t(`general.externalAgentConnection.statuses.${info?.mcp.status ?? 'loading'}`),
                control: t(
                  `general.externalAgentConnection.statuses.${info?.control.status ?? 'loading'}`
                ),
                cdp: t(`general.externalAgentConnection.statuses.${info?.cdp.status ?? 'loading'}`),
              })}
            </p>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={retrying}
              onClick={() => void retry()}
            >
              {t(
                retrying
                  ? 'general.externalAgentConnection.retrying'
                  : 'general.externalAgentConnection.retry'
              )}
            </Button>
          </div>
          {(error || info?.reason) && (
            <p role="status" className="text-xs text-[var(--warning-text)]">
              {error ?? info?.reason}
            </p>
          )}
          {info?.recovery && (
            <p className="text-xs text-[var(--color-text-muted)]">{info.recovery}</p>
          )}
          <dl className="space-y-2 text-xs">
            {endpoints.map(([label, value]) =>
              value ? (
                <div key={label}>
                  <dt className="text-[var(--color-text-muted)]">{label}</dt>
                  <dd className="select-text break-all font-mono text-[var(--color-text)]">
                    {value}
                  </dd>
                </div>
              ) : null
            )}
          </dl>
          <div className="flex items-center justify-between gap-4 border-t border-[var(--color-border)] pt-3">
            <div className="space-y-1">
              <Label htmlFor="external-agent-cdp">
                {t('general.externalAgentConnection.cdpLabel')}
              </Label>
              <p className="text-xs text-[var(--color-text-muted)]">
                {t('general.externalAgentConnection.cdpDescription')}
              </p>
            </div>
            <Switch
              id="external-agent-cdp"
              checked={cdpEnabled}
              onCheckedChange={onCdpEnabledChange}
              disabled={saving}
            />
          </div>
          {restartRequired && (
            <p role="status" className="text-xs text-[var(--warning-text)]">
              {t('general.externalAgentConnection.restartRequired')}
              {!cdpEnabled && cdpOpen ? ` ${t('general.externalAgentConnection.stillOpen')}` : ''}
            </p>
          )}
        </>
      )}
    </section>
  );
}
