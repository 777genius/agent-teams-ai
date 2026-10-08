import { useEffect, useMemo, useRef, useState } from 'react';

import { buildExternalAgentPrompt } from '@features/external-agent-connection';
import { useAppTranslation } from '@features/localization/renderer';
import { TEAM_TEMPLATES } from '@features/team-templates';
import { Button } from '@renderer/components/ui/button';
import { Label } from '@renderer/components/ui/label';
import { Textarea } from '@renderer/components/ui/textarea';
import { useDraftPersistence } from '@renderer/hooks/useDraftPersistence';
import { Check, Copy } from 'lucide-react';

import { ExternalAgentRunActions } from './ExternalAgentRunActions';
import { TeamTemplateReferences } from './TeamTemplateReferences';

import type {
  ConnectionInfoV1,
  ExternalAgentConnectionApi,
  ExternalAgentRunApi,
} from '../contracts';

interface Props {
  api: ExternalAgentConnectionApi;
  connection: ConnectionInfoV1;
  isLight: boolean;
  onSettings(): void;
  runApi?: ExternalAgentRunApi;
}

function createPrompt(task: string, connection: ConnectionInfoV1): string {
  return buildExternalAgentPrompt({
    task,
    intent: 'manage',
    templates: TEAM_TEMPLATES,
    connection,
    includeCdp: connection.cdp.status === 'ready' && connection.capabilities.rendererControl,
  });
}

function snapshotSignature(connection: ConnectionInfoV1): string {
  return JSON.stringify([
    connection.context,
    connection.mcp,
    connection.control,
    connection.cdp,
    connection.capabilities,
  ]);
}

/** Mounted per live app/root. Its persistent task key deliberately excludes appInstanceId. */
export const ExternalAgentPromptDialog = ({
  api,
  connection,
  isLight,
  onSettings,
  runApi,
}: Readonly<Props>): React.JSX.Element => {
  const { t } = useAppTranslation('team');
  const { t: settingsT } = useAppTranslation('settings');
  const request = useDraftPersistence({
    key: `externalAgentPrompt:${connection.profileFingerprint}:${connection.context.dataRootFingerprint}`,
  });
  const [busy, setBusy] = useState(false);
  const [previewBlocked, setPreviewBlocked] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [generated, setGenerated] = useState<{
    task: string;
    signature: string;
    prompt: string;
  } | null>(null);
  const [receipt, setReceipt] = useState<{ task: string; signature: string } | null>(null);
  const [copySnapshot, setCopySnapshot] = useState<ConnectionInfoV1 | null>(null);
  const currentConnection =
    copySnapshot && copySnapshot.observedAt >= connection.observedAt ? copySnapshot : connection;
  const currentTask = useRef(request.value);
  const mounted = useRef(true);
  useEffect(() => {
    currentTask.current = request.value;
  }, [request.value]);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const signature = snapshotSignature(currentConnection);
  const ready =
    currentConnection.mcp.status === 'ready' &&
    Boolean(currentConnection.mcp.url) &&
    currentConnection.control.status === 'ready' &&
    currentConnection.capabilities.draftCreation;
  const taskPresent = Boolean(request.value.trim());
  const copied = receipt?.task === request.value && receipt.signature === signature;
  const preview = useMemo(() => {
    if (previewBlocked || !ready || !taskPresent) return '';
    if (generated?.task === request.value && generated.signature === signature)
      return generated.prompt;
    try {
      return createPrompt(request.value, currentConnection);
    } catch {
      return '';
    }
  }, [currentConnection, generated, previewBlocked, ready, request.value, signature, taskPresent]);

  const copy = async (): Promise<void> => {
    if (busy || !ready || !taskPresent) return;
    const task = request.value;
    setBusy(true);
    setError(null);
    setReceipt(null);
    let writingClipboard = false;
    try {
      const live = await api.getConnectionInfo();
      if (!mounted.current) return;
      if (
        live.context.appInstanceId !== connection.context.appInstanceId ||
        live.context.dataRootFingerprint !== connection.context.dataRootFingerprint ||
        live.profileFingerprint !== connection.profileFingerprint
      ) {
        throw new Error(t('externalPrompt.contextChanged'));
      }
      const prompt = createPrompt(task, live);
      if (currentTask.current !== task) return;
      const freshSignature = snapshotSignature(live);
      setPreviewBlocked(false);
      setCopySnapshot(live);
      setGenerated({ task, signature: freshSignature, prompt });
      writingClipboard = true;
      await navigator.clipboard.writeText(prompt);
      if (mounted.current && currentTask.current === task)
        setReceipt({ task, signature: freshSignature });
    } catch (cause) {
      if (!mounted.current) return;
      if (!writingClipboard) {
        setPreviewBlocked(true);
        setGenerated(null);
      }
      if (currentTask.current !== task) return;
      setError(
        writingClipboard
          ? t('externalPrompt.copyFailed')
          : cause instanceof Error
            ? cause.message
            : t('externalPrompt.connectionRequired')
      );
    } finally {
      if (mounted.current) setBusy(false);
    }
  };

  return (
    <div className="min-w-0 space-y-4" data-testid="external-agent-prompt-content">
      <div className="space-y-2">
        <Label htmlFor="external-agent-task">{t('externalPrompt.taskLabel')}</Label>
        <Textarea
          id="external-agent-task"
          autoFocus
          value={request.value}
          onChange={(event) => {
            currentTask.current = event.target.value;
            request.setValue(event.target.value);
            setError(null);
            setReceipt(null);
          }}
          placeholder={t('externalPrompt.taskPlaceholder')}
          className="min-h-24 text-sm"
          aria-describedby="external-agent-task-help"
        />
        <p id="external-agent-task-help" className="text-xs text-[var(--color-text-muted)]">
          {t('externalPrompt.requestHelp')}{' '}
          {currentConnection.capabilities.configurationEdit
            ? t('externalPrompt.editAvailable')
            : ''}{' '}
          {currentConnection.capabilities.reversibleTrash ? t('externalPrompt.trashAvailable') : ''}
          {!currentConnection.capabilities.configurationEdit &&
          !currentConnection.capabilities.reversibleTrash
            ? t('externalPrompt.createOnly')
            : ''}
        </p>
      </div>
      <div className="min-w-0 space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <Label id="external-agent-prompt-preview-label">{t('externalPrompt.previewLabel')}</Label>
          <Button
            type="button"
            size="sm"
            onClick={() => void copy()}
            disabled={busy || !ready || !taskPresent}
            data-testid="external-agent-prompt-copy"
            className="h-auto min-h-8 max-w-full whitespace-normal bg-blue-600 text-white hover:bg-blue-500"
          >
            {copied ? (
              <Check className="size-3.5 shrink-0" />
            ) : (
              <Copy className="size-3.5 shrink-0" />
            )}
            {t(
              busy
                ? 'externalPrompt.copying'
                : copied
                  ? 'externalPrompt.copied'
                  : 'externalPrompt.copy'
            )}
          </Button>
        </div>
        <p className="text-xs text-[var(--color-text-muted)]" aria-live="polite" role="status">
          {error ?? (copied ? t('externalPrompt.copiedDescription') : '')}
        </p>
        <div
          id="external-agent-prompt-preview"
          role="region"
          aria-labelledby="external-agent-prompt-preview-label"
          tabIndex={0}
          onKeyDown={(event) => {
            if (
              !(event.ctrlKey || event.metaKey) ||
              event.altKey ||
              event.key.toLowerCase() !== 'a'
            )
              return;
            const selection = event.currentTarget.ownerDocument.defaultView?.getSelection();
            if (!selection) return;
            event.preventDefault();
            const range = event.currentTarget.ownerDocument.createRange();
            range.selectNodeContents(event.currentTarget);
            selection.removeAllRanges();
            selection.addRange(range);
          }}
          className="h-36 max-h-36 select-text overflow-y-auto whitespace-pre-wrap break-words rounded-md border border-[var(--color-border)] px-3 py-2 font-mono text-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--color-border-emphasis)]"
          data-testid="external-agent-prompt-preview"
        >
          {preview || (
            <span className="text-[var(--color-text-muted)]">
              {t('externalPrompt.previewPlaceholder')}
            </span>
          )}
        </div>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="break-words text-xs text-[var(--color-text-secondary)]" aria-live="polite">
            {t('externalPrompt.connectionStatus', {
              mcp: settingsT(
                `general.externalAgentConnection.statuses.${currentConnection.mcp.status}`
              ),
              cdp: settingsT(
                `general.externalAgentConnection.statuses.${currentConnection.cdp.status}`
              ),
            })}
          </p>
          <Button type="button" variant="link" size="sm" onClick={onSettings}>
            {t('externalPrompt.connectionSettings')}
          </Button>
        </div>
        {!ready && (
          <p className="text-xs text-[var(--warning-text)]" role="status">
            {currentConnection.reason ?? t('externalPrompt.connectionRequired')}
          </p>
        )}
      </div>
      {runApi && (
        <ExternalAgentRunActions
          api={runApi}
          task={request.value}
          context={currentConnection.context}
          ready={ready}
        />
      )}
      <TeamTemplateReferences isLight={isLight} />
    </div>
  );
};
