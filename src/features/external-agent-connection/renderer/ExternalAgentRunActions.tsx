import { useAppTranslation } from '@features/localization/renderer';
import { CliLogsRichView } from '@renderer/components/team/CliLogsRichView';
import { Button } from '@renderer/components/ui/button';
import { Loader2 } from 'lucide-react';

import { useExternalAgentRun } from './useExternalAgentRun';

import type { AppConnectionContext, ExternalAgentRunApi } from '../contracts';

export function ExternalAgentRunActions({
  api,
  task,
  context,
  ready,
}: Readonly<{
  api: ExternalAgentRunApi;
  task: string;
  context: AppConnectionContext;
  ready: boolean;
}>): React.JSX.Element {
  const { t } = useAppTranslation('team');
  const run = useExternalAgentRun(api, task, context);
  const blocked =
    !ready || !task.trim() || run.loading || run.submitting || run.active || run.snapshotUnknown;
  return (
    <div
      className="min-w-0 space-y-2 rounded-md border border-[var(--color-border)] p-3"
      data-testid="external-agent-run-actions"
    >
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={blocked || !run.codexReady}
          onClick={() => void run.start('codex')}
          data-testid="external-agent-run-codex"
        >
          {t('externalPrompt.runCodex')}
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={blocked || !run.claudeReady}
          onClick={() => void run.start('anthropic')}
          data-testid="external-agent-run-claude"
        >
          {t('externalPrompt.runClaude')}
        </Button>
        {run.active && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={run.cancelling}
            onClick={() => void run.cancel()}
          >
            {t('externalPrompt.runCancel')}
          </Button>
        )}
      </div>
      {!run.codexReady && (
        <p className="text-xs text-[var(--color-text-muted)]">
          {t(
            run.codexDetected ? 'externalPrompt.runCodexNotReady' : 'externalPrompt.runCodexMissing'
          )}
        </p>
      )}
      {!run.claudeReady && (
        <p className="text-xs text-[var(--color-text-muted)]">
          {t(
            run.claudeDetected
              ? 'externalPrompt.runClaudeNotReady'
              : 'externalPrompt.runClaudeMissing'
          )}
        </p>
      )}
      {run.snapshot && (
        <>
          <p className="flex items-center gap-2 text-xs" role="status">
            {run.active && <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />}
            {t(`externalPrompt.runStatuses.${run.snapshot.status}`)} · {run.elapsed}s
          </p>
          <p className="max-h-14 overflow-y-auto break-words text-xs text-[var(--color-text-muted)]">
            {t('externalPrompt.runTask', { task: run.snapshot.task })}
          </p>
          {run.snapshot.status === 'completed' && (
            <p className="text-xs text-[var(--color-text-muted)]">
              {t('externalPrompt.runCompletedHelp')}
            </p>
          )}
          {run.snapshot.error && (
            <p role="alert" className="text-xs text-[var(--warning-text)]">
              {run.snapshot.error}
            </p>
          )}
          {run.snapshot.logs && (
            <CliLogsRichView cliLogsTail={run.snapshot.logs} className="max-h-48 overflow-y-auto" />
          )}
        </>
      )}
      {run.error && (
        <p role="alert" className="text-xs text-[var(--warning-text)]">
          {t('externalPrompt.runRequestFailed')}
        </p>
      )}
    </div>
  );
}
