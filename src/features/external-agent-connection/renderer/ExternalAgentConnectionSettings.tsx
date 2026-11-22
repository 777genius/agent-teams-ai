import { useState } from 'react';

import {
  buildConnectionSetupPrompt,
  buildMcpRegistrationCommand,
  hasReadyRendererAccess,
} from '@features/external-agent-connection';
import { useAppTranslation } from '@features/localization/renderer';
import { Button } from '@renderer/components/ui/button';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@renderer/components/ui/collapsible';
import { Label } from '@renderer/components/ui/label';
import { Switch } from '@renderer/components/ui/switch';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@renderer/components/ui/tabs';
import { CheckCircle2, ChevronDown, Copy } from 'lucide-react';

import { useConnectionInfo } from './useConnectionInfo';

import type { ConnectionInfoV1, ExternalAgentConnectionApi } from '../contracts';

interface Props {
  api: ExternalAgentConnectionApi;
  local: boolean;
  cdpEnabled: boolean;
  saving: boolean;
  onCdpEnabledChange(enabled: boolean): void;
  onOpenTeams(): void;
}

type Client = 'codex' | 'claude' | 'other';
type CopyKind = Client | 'prompt';

function sameApp(a: ConnectionInfoV1, b: ConnectionInfoV1): boolean {
  return (
    a.context.appInstanceId === b.context.appInstanceId &&
    a.context.dataRootFingerprint === b.context.dataRootFingerprint &&
    a.profileFingerprint === b.profileFingerprint
  );
}

export function ExternalAgentConnectionSettings({
  api,
  local,
  cdpEnabled,
  saving,
  onCdpEnabledChange,
  onOpenTeams,
}: Readonly<Props>): React.JSX.Element {
  const { t } = useAppTranslation('settings');
  const { info, error, retrying, retry } = useConnectionInfo(api, local);
  const [copyStatus, setCopyStatus] = useState('');
  const [lastCopy, setLastCopy] = useState<CopyKind | null>(null);
  const [copying, setCopying] = useState(false);
  const ready = info?.mcp.status === 'ready' && info.control.status === 'ready' && !!info.mcp.url;
  const disabled = info?.errorCode === 'MCP_HTTP_DISABLED';
  const cdpReady = Boolean(info && cdpEnabled && hasReadyRendererAccess(info));
  const cdpOpen =
    Boolean(info?.cdp.httpOrigin) &&
    (info?.cdp.status === 'ready' || info?.cdp.status === 'restart-required');
  // A saved preference cannot revoke an already open native CDP listener.
  const restartRequired =
    info?.cdp.status === 'restart-required' ||
    (cdpEnabled && info?.cdp.status === 'disabled') ||
    (!cdpEnabled && cdpOpen);
  const endpoints = [
    ['CDP HTTP', cdpOpen ? info?.cdp.httpOrigin : null],
    ['Browser WebSocket', cdpOpen ? info?.cdp.browserWsUrl : null],
    ['Renderer target', cdpOpen ? info?.cdp.rendererTargetId : null],
    ['Renderer WebSocket', cdpOpen ? info?.cdp.rendererWsUrl : null],
  ];

  const copy = async (client: CopyKind): Promise<void> => {
    if (!info || !ready || copying || (client === 'prompt' && !cdpReady)) return;
    setCopying(true);
    setLastCopy(client);
    setCopyStatus('');
    try {
      const live = await api.getConnectionInfo();
      if (
        !sameApp(info, live) ||
        live.mcp.status !== 'ready' ||
        live.control.status !== 'ready' ||
        !live.mcp.url ||
        (client === 'prompt' && !hasReadyRendererAccess(live))
      ) {
        setCopyStatus(t('general.externalAgentConnection.copyUnavailable'));
        return;
      }
      const value =
        client === 'prompt'
          ? buildConnectionSetupPrompt(live)
          : client === 'other'
            ? live.mcp.url
            : buildMcpRegistrationCommand(live, client);
      try {
        await navigator.clipboard.writeText(value);
        setCopyStatus(t('general.externalAgentConnection.copied'));
      } catch {
        setCopyStatus(t('general.externalAgentConnection.copyFailed'));
      }
    } catch {
      setCopyStatus(t('general.externalAgentConnection.copyUnavailable'));
    } finally {
      setCopying(false);
    }
  };

  const connectionSetup = (client: Client): React.JSX.Element => {
    const value =
      ready && info
        ? client === 'other'
          ? info.mcp.url
          : buildMcpRegistrationCommand(info, client)
        : null;
    return (
      <div className="space-y-3 pt-2">
        <p className="text-sm text-[var(--color-text-secondary)]">
          {t(
            !ready
              ? 'general.externalAgentConnection.setupUnavailable'
              : client === 'other'
                ? 'general.externalAgentConnection.otherInstructions'
                : 'general.externalAgentConnection.cliInstructions'
          )}
        </p>
        {value && (
          <div className="flex flex-wrap items-start gap-2">
            <code className="min-w-0 flex-1 select-all break-all rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] p-3 text-xs text-[var(--color-text)]">
              {value}
            </code>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={copying}
              onClick={() => void copy(client)}
            >
              <Copy className="size-3.5" aria-hidden="true" />
              {t(
                client === 'other'
                  ? 'general.externalAgentConnection.copyAddress'
                  : 'general.externalAgentConnection.copyCommand'
              )}
            </Button>
          </div>
        )}
        {ready && (
          <p className="text-xs text-[var(--color-text-muted)]">
            {t('general.externalAgentConnection.verifyInstructions')}
          </p>
        )}
      </div>
    );
  };

  return (
    <section
      className="mt-6 max-w-3xl space-y-5"
      aria-label={t('general.externalAgentConnection.title')}
    >
      <div className="space-y-1">
        <h3 className="text-base font-semibold text-[var(--color-text)]">
          {t('general.externalAgentConnection.heading')}
        </h3>
        <p className="text-sm text-[var(--color-text-secondary)]">
          {t('general.externalAgentConnection.description')}
        </p>
      </div>
      {!local ? (
        <p className="text-sm text-[var(--warning-text)]">
          {t('general.externalAgentConnection.localOnly')}
        </p>
      ) : (
        <>
          <div
            className={`rounded-lg border p-4 ${ready ? 'border-emerald-500/40 bg-emerald-500/10' : 'border-[var(--color-border)]'}`}
            aria-live="polite"
            data-testid="external-agent-server-status"
          >
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex min-w-0 items-start gap-3">
                {ready && (
                  <CheckCircle2
                    className="mt-0.5 size-5 shrink-0 text-emerald-600 dark:text-emerald-400"
                    aria-hidden="true"
                  />
                )}
                <div className="space-y-1">
                  <p
                    className={`text-sm font-medium ${ready ? 'text-emerald-700 dark:text-emerald-400' : 'text-[var(--color-text)]'}`}
                  >
                    {t(
                      ready
                        ? 'general.externalAgentConnection.serverReady'
                        : error || info?.mcp.status === 'error' || info?.mcp.status === 'stopped'
                          ? 'general.externalAgentConnection.serverUnavailable'
                          : 'general.externalAgentConnection.serverStarting'
                    )}
                  </p>
                  <p className="text-xs text-[var(--color-text-muted)]">
                    {t(
                      ready
                        ? 'general.externalAgentConnection.readyExplanation'
                        : disabled
                          ? 'general.externalAgentConnection.disabledExplanation'
                          : 'general.externalAgentConnection.waitExplanation'
                    )}
                  </p>
                </div>
              </div>
              {!ready && !disabled && (
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
              )}
            </div>
            {!ready && !disabled && (error || info?.reason) && (
              <p className="mt-2 break-words text-xs text-[var(--warning-text)]">
                {error ?? info?.reason}
              </p>
            )}
            {!ready && !disabled && info?.recovery && (
              <p className="mt-1 text-xs text-[var(--color-text-muted)]">{info.recovery}</p>
            )}
          </div>
          <div className="space-y-2 rounded-lg border border-[var(--color-border)] p-4">
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0 space-y-1">
                <Label htmlFor="external-agent-cdp">
                  {t('general.externalAgentConnection.cdpLabel')}
                </Label>
                <p
                  id="external-agent-cdp-description"
                  className="text-xs text-[var(--color-text-muted)]"
                >
                  {t('general.externalAgentConnection.cdpShortDescription')}
                </p>
              </div>
              <Switch
                id="external-agent-cdp"
                aria-describedby="external-agent-cdp-description external-agent-cdp-status"
                checked={cdpEnabled}
                onCheckedChange={onCdpEnabledChange}
                disabled={saving}
              />
            </div>
            <p
              id="external-agent-cdp-status"
              role="status"
              className={`text-xs ${cdpReady ? 'text-emerald-700 dark:text-emerald-400' : 'text-[var(--warning-text)]'}`}
            >
              {t(
                cdpReady
                  ? 'general.externalAgentConnection.cdpReady'
                  : !cdpEnabled
                    ? 'general.externalAgentConnection.cdpEnableHint'
                    : restartRequired
                      ? 'general.externalAgentConnection.restartRequired'
                      : info?.cdp.status === 'error'
                        ? 'general.externalAgentConnection.cdpError'
                        : 'general.externalAgentConnection.cdpStarting'
              )}
              {!cdpEnabled && cdpOpen ? ` ${t('general.externalAgentConnection.stillOpen')}` : ''}
            </p>
          </div>
          <Tabs defaultValue="prompt" onValueChange={() => setCopyStatus('')}>
            <TabsList
              aria-label={t('general.externalAgentConnection.chooseMethod')}
              className="grid h-auto w-full grid-cols-2 gap-1 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-raised)] p-1"
            >
              <TabsTrigger
                value="prompt"
                className="h-full min-w-0 flex-col items-start justify-start gap-1 whitespace-normal rounded-md border border-transparent p-3 text-start data-[state=active]:border-[var(--color-border)] data-[state=active]:bg-[var(--color-surface)] data-[state=active]:shadow-sm"
              >
                <span className="font-semibold">
                  {t('general.externalAgentConnection.promptHeading')}
                </span>
                <span className="text-xs font-normal text-[var(--color-text-muted)]">
                  {t('general.externalAgentConnection.promptCardHelp')}
                </span>
              </TabsTrigger>
              <TabsTrigger
                value="manual"
                className="h-full min-w-0 flex-col items-start justify-start gap-1 whitespace-normal rounded-md border border-transparent p-3 text-start data-[state=active]:border-[var(--color-border)] data-[state=active]:bg-[var(--color-surface)] data-[state=active]:shadow-sm"
              >
                <span className="font-semibold">
                  {t('general.externalAgentConnection.chooseClient')}
                </span>
                <span className="text-xs font-normal text-[var(--color-text-muted)]">
                  {t('general.externalAgentConnection.manualCardHelp')}
                </span>
              </TabsTrigger>
            </TabsList>
            <TabsContent value="prompt" className="space-y-3 pt-3">
              <p className="text-sm text-[var(--color-text-secondary)]">
                {t('general.externalAgentConnection.promptHelp')}
              </p>
              <Button
                type="button"
                size="sm"
                disabled={!ready || !cdpReady || copying}
                onClick={() => void copy('prompt')}
              >
                <Copy className="size-3.5" aria-hidden="true" />
                {t(
                  copying && lastCopy === 'prompt'
                    ? 'general.externalAgentConnection.copyingPrompt'
                    : 'general.externalAgentConnection.copyPrompt'
                )}
              </Button>
              <p className="text-xs text-[var(--color-text-muted)]" role="status">
                {lastCopy === 'prompt' ? copyStatus : ''}
              </p>
              <p className="text-xs text-[var(--color-text-muted)]">
                {t('general.externalAgentConnection.localExecutorShort')}
              </p>
            </TabsContent>
            <TabsContent value="manual" className="space-y-3 pt-3">
              <Tabs defaultValue="codex" onValueChange={() => setCopyStatus('')}>
                <TabsList className="h-auto max-w-full flex-wrap justify-start">
                  <TabsTrigger value="codex">Codex</TabsTrigger>
                  <TabsTrigger value="claude">Claude Code</TabsTrigger>
                  <TabsTrigger value="other">
                    {t('general.externalAgentConnection.otherClient')}
                  </TabsTrigger>
                </TabsList>
                <TabsContent value="codex">{connectionSetup('codex')}</TabsContent>
                <TabsContent value="claude">{connectionSetup('claude')}</TabsContent>
                <TabsContent value="other">{connectionSetup('other')}</TabsContent>
              </Tabs>
              <p className="text-xs text-[var(--color-text-muted)]" role="status">
                {lastCopy !== 'prompt' ? copyStatus : ''}
              </p>
              <p className="text-xs text-[var(--color-text-muted)]">
                {t('general.externalAgentConnection.manualCdpHelp')}
              </p>
              <p className="text-xs text-[var(--color-text-muted)]">
                {t('general.externalAgentConnection.localExecutorShort')}
              </p>
            </TabsContent>
          </Tabs>
          <p className="text-xs text-[var(--warning-text)]">
            {t('general.externalAgentConnection.mcpTrust')}
          </p>
          <Collapsible>
            <CollapsibleTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-auto min-h-10 w-full justify-between border border-[var(--color-border)] px-3 py-2 text-start"
              >
                <span className="whitespace-normal">
                  {t('general.externalAgentConnection.nextStep')}
                </span>
                <ChevronDown className="size-4 shrink-0" aria-hidden="true" />
              </Button>
            </CollapsibleTrigger>
            <CollapsibleContent className="space-y-2 pb-2">
              <p className="text-xs text-[var(--color-text-muted)]">
                {t('general.externalAgentConnection.nextStepHelp')}
              </p>
              <Button type="button" variant="outline" size="sm" onClick={onOpenTeams}>
                {t('general.externalAgentConnection.openTeams')}
              </Button>
            </CollapsibleContent>
          </Collapsible>
          <Collapsible>
            <CollapsibleTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-auto min-h-10 w-full justify-between border border-[var(--color-border)] px-3 py-2 text-start"
              >
                <span className="whitespace-normal">
                  {t('general.externalAgentConnection.advanced')}
                </span>
                <ChevronDown className="size-4 shrink-0" aria-hidden="true" />
              </Button>
            </CollapsibleTrigger>
            <CollapsibleContent className="space-y-3 pt-3">
              <p className="text-xs text-[var(--color-text-muted)]">
                {t('general.externalAgentConnection.addressChanges')}
              </p>
              <p className="text-xs text-[var(--color-text-muted)]">
                {t('general.externalAgentConnection.cdpDescription')}
              </p>
              <p className="text-xs text-[var(--color-text-muted)]">
                {t('general.externalAgentConnection.status', {
                  mcp: t(
                    `general.externalAgentConnection.statuses.${info?.mcp.status ?? 'loading'}`
                  ),
                  control: t(
                    `general.externalAgentConnection.statuses.${info?.control.status ?? 'loading'}`
                  ),
                  cdp: t(
                    `general.externalAgentConnection.statuses.${info?.cdp.status ?? 'loading'}`
                  ),
                })}
              </p>
              {ready && info?.cdp.status === 'error' && info.reason && (
                <p className="text-xs text-[var(--warning-text)]">
                  {info.reason} {info.recovery}
                </p>
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
            </CollapsibleContent>
          </Collapsible>
        </>
      )}
    </section>
  );
}
